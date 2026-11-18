import { severityAtLeast, type Finding, type Verdict } from '@hansi/engine';
import type { ExpectedFinding } from './case';

/** Lines a finding may sit away from an expected problem and still count, by default. */
export const DEFAULT_TOLERANCE = 5;

export type ReportedFinding = Pick<
	Finding,
	'path' | 'startLine' | 'endLine' | 'severity' | 'category' | 'title' | 'body'
>;

/**
 * Picks which of `candidates` reports `expected`, by index, or null when none does. Candidates
 * are on the same file and not yet matched to another expected problem.
 */
export type Judge = (
	expected: ExpectedFinding,
	candidates: ReportedFinding[]
) => Promise<number | null>;

export interface Match {
	expected: string;
	/** Index into the findings matched against. */
	finding: number;
}

export interface MatchResult {
	matches: Match[];
	/** Expected problems no finding reported. */
	missed: string[];
	/** Findings that report no expected problem, by index. */
	unmatched: number[];
}

/** Lines between a finding and an expected problem; 0 when they overlap. */
export function lineDistance(expected: ExpectedFinding, finding: ReportedFinding): number {
	const [start, end] = expected.lines;
	if (finding.endLine < start) return start - finding.endLine;
	if (finding.startLine > end) return finding.startLine - end;
	return 0;
}

/**
 * Pairs findings with expected problems, each at most once. A finding counts for a problem when
 * it is on the same file, at the problem's severity or above, and either within `tolerance`
 * lines or, with a judge, when the judge says it reports that problem. The judge sees every
 * finding on the file: a finding on the caller still reports the bug.
 *
 * By line, the pairing catches as many problems as any pairing could, whatever order the labels
 * are in, preferring nearer findings: one finding between two problems does not cost the other
 * its match. A judge is asked problem by problem, in the labels' order.
 */
export async function matchFindings(
	expected: ExpectedFinding[],
	findings: ReportedFinding[],
	options: { tolerance?: number; judge?: Judge } = {}
): Promise<MatchResult> {
	const counts = (problem: ExpectedFinding, finding: ReportedFinding) =>
		finding.path === problem.path &&
		(!problem.severity || severityAtLeast(finding.severity, problem.severity));

	const owner = options.judge
		? await judgeMatches(expected, findings, counts, options.judge)
		: lineMatches(expected, findings, counts, options.tolerance ?? DEFAULT_TOLERANCE);

	const matchedBy = new Map([...owner].map(([finding, problem]) => [problem, finding]));
	const matches: Match[] = [];
	const missed: string[] = [];
	expected.forEach((problem, index) => {
		const finding = matchedBy.get(index);
		if (finding === undefined) missed.push(problem.id);
		else matches.push({ expected: problem.id, finding });
	});
	const unmatched = findings.map((_, index) => index).filter((index) => !owner.has(index));
	return { matches, missed, unmatched };
}

type Counts = (problem: ExpectedFinding, finding: ReportedFinding) => boolean;

/** Which problem each finding is matched to, by index: a maximum matching over nearby findings. */
function lineMatches(
	expected: ExpectedFinding[],
	findings: ReportedFinding[],
	counts: Counts,
	tolerance: number
): Map<number, number> {
	// Each problem's candidates, nearest first, so an augmenting path tries near findings first.
	const candidates = expected.map((problem) =>
		findings
			.map((finding, index) => ({ index, distance: lineDistance(problem, finding) }))
			.filter(({ index, distance }) => distance <= tolerance && counts(problem, findings[index]!))
			.sort((a, b) => a.distance - b.distance)
			.map((c) => c.index)
	);
	const owner = new Map<number, number>();
	const assign = (problem: number, seen: Set<number>): boolean => {
		for (const finding of candidates[problem]!) {
			if (seen.has(finding)) continue;
			seen.add(finding);
			const current = owner.get(finding);
			if (current === undefined || assign(current, seen)) {
				owner.set(finding, problem);
				return true;
			}
		}
		return false;
	};
	expected.forEach((_, problem) => assign(problem, new Set()));
	return owner;
}

async function judgeMatches(
	expected: ExpectedFinding[],
	findings: ReportedFinding[],
	counts: Counts,
	judge: Judge
): Promise<Map<number, number>> {
	const owner = new Map<number, number>();
	for (const [problem, label] of expected.entries()) {
		const candidates = findings
			.map((finding, index) => ({ finding, index }))
			.filter(({ finding, index }) => !owner.has(index) && counts(label, finding));
		if (candidates.length === 0) continue;
		const choice = await judge(
			label,
			candidates.map((c) => c.finding)
		);
		const picked = choice === null ? undefined : candidates[choice]?.index;
		if (picked !== undefined) owner.set(picked, problem);
	}
	return owner;
}

/** What one review of one case scored. */
export interface CaseScore {
	expected: number;
	/** Expected problems a posted finding reported. */
	caught: string[];
	/** Expected problems no posted finding reported. */
	missed: string[];
	/** Missed problems a dropped finding had reported: the verifier or a filter threw them away. */
	droppedHits: { expected: string; reason: string }[];
	posted: number;
	/** Posted findings that report no expected problem. On a clean case these are false alarms. */
	extra: { path: string; startLine: number; severity: string; title: string }[];
	verdict: Verdict;
	/** Null when the case expects no verdict. */
	verdictOk: boolean | null;
}

export interface ScoreInput {
	expected: ExpectedFinding[];
	expectedVerdict?: Verdict;
	posted: ReportedFinding[];
	dropped: (ReportedFinding & { dropReason: string })[];
	verdict: Verdict;
	tolerance?: number;
	judge?: Judge;
}

export async function scoreReview(input: ScoreInput): Promise<CaseScore> {
	const options = { tolerance: input.tolerance, judge: input.judge };
	const posted = await matchFindings(input.expected, input.posted, options);
	const stillMissed = input.expected.filter((e) => posted.missed.includes(e.id));
	const dropped = await matchFindings(stillMissed, input.dropped, options);

	return {
		expected: input.expected.length,
		caught: posted.matches.map((m) => m.expected),
		missed: posted.missed,
		droppedHits: dropped.matches.map((m) => ({
			expected: m.expected,
			reason: input.dropped[m.finding]!.dropReason
		})),
		posted: input.posted.length,
		extra: posted.unmatched.map((index) => {
			const f = input.posted[index]!;
			return { path: f.path, startLine: f.startLine, severity: f.severity, title: f.title };
		}),
		verdict: input.verdict,
		verdictOk: input.expectedVerdict ? input.verdict === input.expectedVerdict : null
	};
}
