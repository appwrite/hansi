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
 * lines (the nearest wins) or, with a judge, when the judge says it reports that problem. The
 * judge sees every finding on the file: a finding on the caller still reports the bug.
 */
export async function matchFindings(
	expected: ExpectedFinding[],
	findings: ReportedFinding[],
	options: { tolerance?: number; judge?: Judge } = {}
): Promise<MatchResult> {
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const used = new Set<number>();
	const matches: Match[] = [];
	const missed: string[] = [];

	for (const problem of expected) {
		const candidates = findings
			.map((finding, index) => ({ finding, index }))
			.filter(
				({ finding, index }) =>
					!used.has(index) &&
					finding.path === problem.path &&
					(!problem.severity || severityAtLeast(finding.severity, problem.severity))
			);

		let picked: number | null = null;
		if (options.judge) {
			if (candidates.length > 0) {
				const choice = await options.judge(
					problem,
					candidates.map((c) => c.finding)
				);
				picked = choice === null ? null : (candidates[choice]?.index ?? null);
			}
		} else {
			const near = candidates
				.map((c) => ({ ...c, distance: lineDistance(problem, c.finding) }))
				.filter((c) => c.distance <= tolerance)
				.sort((a, b) => a.distance - b.distance);
			picked = near[0]?.index ?? null;
		}

		if (picked === null) {
			missed.push(problem.id);
			continue;
		}
		used.add(picked);
		matches.push({ expected: problem.id, finding: picked });
	}

	const unmatched = findings.map((_, index) => index).filter((index) => !used.has(index));
	return { matches, missed, unmatched };
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
