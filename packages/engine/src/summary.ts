import { severityAtLeast, type Severity, type Verdict } from './config';
import type { Log } from './context';
import type { Finding } from './findings';
import {
	filesTooLargeFromBody,
	formatSummaryComment,
	STALE_HEAD_NOTE_MARK,
	SUMMARY_MARKER,
	type SummaryInput
} from './format';
import type { GitHubConnection } from './github';
import { statusBlockOf, withStatusBlock } from './progress';
import type { FindingRecord, PullRef, ResultsSink } from './results';
import { lastCompleted, reviewDetailsUrl, withdrawChangeRequests } from './shared';
import { CHANGE_REQUEST_DISMISSAL } from './submit-review';
import { standingFromOpenFindings } from './tier';

type FindingRow = {
	reviewId: string;
	path: string;
	startLine: number;
	endLine: number;
	severity: string;
	category: string;
	title: string;
	body: string;
	suggestion: string | null;
	status: string;
	dropReason: string | null;
};

/** Fields that live only in the summary comment, not on the review row. */
export type SummaryExtras = {
	latestChanges?: string | null;
	approvalWithheld?: string | null;
	staleHead?: string | null;
	incrementalFrom?: string;
	/** Reviewable files that did not fit in the prompt. Null when the summary does not say so. */
	filesTooLargeForPrompt?: { omitted: number; total: number } | null;
	/** Footer sentence written when a merge did not change the pull request. */
	scope?: string;
};

/**
 * Recovers review-context details from an existing summary body so a settlement rebuild does not
 * drop them. These are not stored on the review row.
 */
export function summaryExtrasFromBody(body: string): SummaryExtras {
	// latestChanges can span lines; it always sits before the verdict table.
	const latestChanges =
		body.match(/\*\*Latest changes:\*\* ([\s\S]*?)\n\n\| Verdict \|/)?.[1] ?? null;
	const noteLines = [...body.matchAll(/> \[!NOTE\]\n> (.+)/g)].map((match) => match[1] ?? '');
	const stalePrefix = `${STALE_HEAD_NOTE_MARK} `;
	const staleLine = noteLines.find((line) => line.startsWith(stalePrefix));
	const approvalWithheld = noteLines.find((line) => !line.startsWith(stalePrefix)) ?? null;
	const incrementalFrom = body.match(/Reviewed the commits since <code>([0-9a-f]+)<\/code>/i)?.[1];
	const scope = body.match(
		/Merged <code>[^<]*<\/code> \(<code>[0-9a-f]+<\/code>\); no changes to this PR's code since <code>[0-9a-f]+<\/code>/
	)?.[0];
	return {
		latestChanges,
		approvalWithheld,
		filesTooLargeForPrompt: filesTooLargeFromBody(body),
		staleHead: staleLine ? staleLine.slice(stalePrefix.length) : null,
		...(incrementalFrom ? { incrementalFrom } : {}),
		...(scope ? { scope } : {})
	};
}

/** Findings the settlement rebuild turns back into the summary comment. Dismissed ones are omitted. */
export function summaryFindings(findings: readonly FindingRecord[]): FindingRow[] {
	return findings.filter((f) => f.status !== 'dismissed').slice(0, 200);
}

/** Rebuilds the summary comment after a finding is resolved or dismissed in a thread. */
export async function refreshSummaryAfterSettlement(input: {
	results: ResultsSink;
	connection: GitHubConnection;
	pull: PullRef;
	/** `owner/name`. */
	repository: string;
	consoleUrl?: string;
	/** Findings at or above this severity block the pull request (`reviews.requestChanges`). */
	blockingSeverity: Severity;
	log: Log;
}): Promise<void> {
	const { results, connection, pull } = input;
	const { github, app } = connection;
	const mention = `@${app.slug}`;

	const last = lastCompleted(await results.listReviews(pull));
	if (!last?.summary || !last.verdict) return;

	const rows = summaryFindings(await results.listFindings(pull, { limit: 200 }));
	const blockingOpen = hasBlockingOpen(rows, input.blockingSeverity);
	// A change request stands while a blocking finding is open; after that the latest verdict
	// becomes a comment. A conversation is not a review of the code, so it never approves.
	const verdict =
		last.verdict === 'request_changes' && !blockingOpen ? 'comment' : (last.verdict as Verdict);

	const existing = await github.getMarkedComment(pull.pullNumber, SUMMARY_MARKER);
	const extras = existing ? summaryExtrasFromBody(existing.body) : {};

	const summaryInput = summaryAfterSettlement({
		repository: input.repository,
		headSha: last.headSha,
		summary: last.summary,
		verdict,
		walkthrough: last.walkthrough ?? [],
		latestReviewId: last.id,
		findings: rows,
		detailsUrl: reviewDetailsUrl(input.consoleUrl, pull.projectId, last.id),
		mention,
		...extras
	});

	// A review running right now keeps its status line above the rebuilt summary.
	await github.upsertMarkedComment(
		pull.pullNumber,
		SUMMARY_MARKER,
		withStatusBlock(formatSummaryComment(summaryInput), existing && statusBlockOf(existing.body))
	);
	await results.updateGrade(
		{ projectId: pull.projectId, reviewId: last.id },
		{ tier: summaryInput.tier, tierReason: summaryInput.tierReason }
	);
	// No blocking finding is left: withdraw any change request, including one an earlier review
	// left in place. Dismissing finds nothing to do when there is none.
	if (!blockingOpen) {
		await withdrawChangeRequests(connection, pull.pullNumber, CHANGE_REQUEST_DISMISSAL, input.log);
	}
}

/** Whether a finding at or above the blocking severity is still open on the pull request. */
export function hasBlockingOpen(
	findings: Pick<FindingRow, 'status' | 'severity'>[],
	blockingSeverity: Severity
): boolean {
	return findings.some(
		(f) => f.status === 'posted' && severityAtLeast(f.severity as Severity, blockingSeverity)
	);
}

/**
 * Turns the latest review plus remaining findings into a summary comment body.
 * Dismissed findings are already excluded from `findings`.
 */
export function summaryAfterSettlement(
	input: {
		repository: string;
		headSha: string;
		summary: string;
		verdict: Verdict;
		walkthrough: { path: string; change: string }[];
		latestReviewId: string;
		findings: FindingRow[];
		detailsUrl?: string;
		mention: string;
	} & SummaryExtras
): SummaryInput {
	const toFinding = (row: FindingRow): Finding => ({
		path: row.path,
		startLine: row.startLine,
		endLine: row.endLine,
		severity: row.severity as Severity,
		category: row.category as Finding['category'],
		title: row.title,
		body: row.body,
		...(row.suggestion ? { suggestion: row.suggestion } : {})
	});

	const shortSha = input.headSha.slice(0, 7);
	const posted = input.findings
		.filter((f) => f.status === 'posted' && f.reviewId === input.latestReviewId)
		.map(toFinding);
	const stillOpen = input.findings
		.filter((f) => f.status === 'posted' && f.reviewId !== input.latestReviewId)
		.map((f) => ({
			path: f.path,
			startLine: f.startLine,
			endLine: f.endLine,
			title: f.title,
			body: f.body,
			...(f.suggestion ? { suggestion: f.suggestion } : {}),
			severity: f.severity as Severity
		}));
	const resolved = input.findings
		.filter((f) => f.status === 'resolved' && f.dropReason === `Fixed by ${shortSha}`)
		.map((f) => ({ path: f.path, startLine: f.startLine, title: f.title }));
	const dropped = input.findings
		.filter((f) => f.status === 'dropped' && f.reviewId === input.latestReviewId)
		.map((f) => ({ ...toFinding(f), dropReason: f.dropReason ?? 'Dropped' }));

	const { tier, tierReason } = standingFromOpenFindings([...posted, ...stillOpen]);

	return {
		repository: input.repository,
		headSha: input.headSha,
		summary: input.summary,
		tier,
		tierReason,
		verdict: input.verdict,
		posted,
		resolved,
		stillOpen,
		dropped,
		walkthrough: input.walkthrough,
		latestChanges: input.latestChanges,
		approvalWithheld: input.approvalWithheld,
		filesTooLargeForPrompt: input.filesTooLargeForPrompt,
		staleHead: input.staleHead,
		incrementalFrom: input.incrementalFrom,
		scope: input.scope,
		detailsUrl: input.detailsUrl,
		mention: input.mention
	};
}
