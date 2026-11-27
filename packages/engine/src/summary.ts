import {
	changeRequestSeverity,
	severityAtLeast,
	type RepoConfig,
	type Severity,
	type Verdict
} from './config';
import type { Log } from './context';
import type { Finding } from './findings';
import {
	absolutizeLinks,
	APPROVES_WHEN_SETTLED_MARK,
	filesTooLargeFromBody,
	formatReviewBody,
	formatSummaryComment,
	latestChangesFromBody,
	summaryVerdictFromBody,
	STALE_HEAD_NOTE_MARK,
	SUMMARY_MARKER,
	type SummaryInput
} from './format';
import type { GitHubConnection } from './github';
import { statusBlockOf, withStatusBlock } from './progress';
import type { FindingRecord, PullRef, ResultsSink } from './results';
import {
	CHECK_NAME,
	checkConclusions,
	lastCompleted,
	reviewDetailsUrl,
	withdrawChangeRequests
} from './shared';
import { CHANGE_REQUEST_DISMISSAL } from './submit-review';
import { standingFromOpenFindings, tierMeaning } from './tier';
import {
	decideVerdict,
	OPEN_DEFECT_NOTE,
	openDefectApprovalReason,
	type VerdictFinding
} from './verdict';

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
	/** Only open findings kept the review from approving. */
	approvesWhenSettled?: boolean;
};

/**
 * Recovers review-context details from an existing summary body so a settlement rebuild does not
 * drop them. These are not stored on the review row.
 */
export function summaryExtrasFromBody(body: string): SummaryExtras {
	const latestChanges = latestChangesFromBody(body);
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
		...(scope ? { scope } : {}),
		...(body.includes(APPROVES_WHEN_SETTLED_MARK) ? { approvesWhenSettled: true } : {})
	};
}

/** Findings the settlement rebuild turns back into the summary comment. Dismissed ones are omitted. */
export function summaryFindings(findings: readonly FindingRecord[]): FindingRow[] {
	return findings.filter((f) => f.status !== 'dismissed').slice(0, 200);
}

/**
 * Rebuilds the summary comment after a finding is resolved or dismissed in a thread, and brings
 * Hansi's standing on the pull request in line with the findings still open: the grade, the
 * change request, the check run and, where the review held it back only for its findings, the
 * approval.
 */
export async function refreshSummaryAfterSettlement(input: {
	results: ResultsSink;
	connection: GitHubConnection;
	pull: PullRef;
	/** Where file links hang off: `<repository>/<sha>/<path>`. */
	repository: string;
	consoleUrl?: string;
	/** The Console's origin, where the status images are served. Absent: the status is text. */
	images?: string;
	/** The base branch's settings: what blocks the pull request, and whether Hansi approves. */
	config: RepoConfig;
	log: Log;
}): Promise<void> {
	const { results, connection, pull, config } = input;
	const { github, app } = connection;
	const mention = `@${app.slug}`;
	const blockingSeverity = changeRequestSeverity(config);

	const last = lastCompleted(await results.listReviews(pull));
	if (!last?.summary || !last.verdict) return;

	const listed = await results.listFindings(pull, { limit: FINDINGS_LIMIT });
	// The list stops at the limit, so a full one may leave open findings out: never approve on it.
	const complete = listed.length < FINDINGS_LIMIT;
	const rows = summaryFindings(listed);
	const open: VerdictFinding[] = rows
		.filter((f) => f.status === 'posted')
		.map((f) => ({ severity: f.severity as Severity, category: f.category, title: f.title }));
	const blockingOpen = hasBlockingOpen(rows, blockingSeverity);

	const existing = await github.getMarkedComment(pull.pullNumber, SUMMARY_MARKER);
	const extras = existing ? summaryExtrasFromBody(existing.body) : {};
	const status = existing && statusBlockOf(existing.body);
	// An earlier settlement may have approved already; the stored review keeps its own verdict.
	const reviewed: Verdict =
		existing && summaryVerdictFromBody(existing.body) === 'approve'
			? 'approve'
			: (last.verdict as Verdict);
	// A note that names an open defect follows the findings; any other note stays as written.
	const withheld = extras.approvalWithheld?.startsWith(OPEN_DEFECT_NOTE)
		? openDefectApprovalReason(open, config)
		: extras.approvalWithheld;

	// A change request stands while a blocking finding is open; after that it becomes a comment.
	const settled: Verdict = reviewed === 'request_changes' && !blockingOpen ? 'comment' : reviewed;
	// The review held approval back only for findings that are now settled: approve, as a review
	// of the same head would. Never while a review is running, which decides for itself, and never
	// over newer commits, which nobody reviewed.
	const reviewedHead = async () =>
		sameSha((await github.getPullRequest(pull.pullNumber)).headSha, last.headSha);
	const current = status ? false : await reviewedHead();
	const approves =
		current &&
		complete &&
		settled !== 'approve' &&
		!!extras.approvesWhenSettled &&
		!extras.staleHead &&
		decideVerdict({ posted: open, stillOpen: [], config }) === 'approve';

	const detailsUrl = reviewDetailsUrl(input.consoleUrl, pull.projectId, last.id);
	const build = (verdict: Verdict) =>
		summaryAfterSettlement({
			repository: input.repository,
			headSha: last.headSha,
			summary: last.summary,
			verdict,
			walkthrough: last.walkthrough ?? [],
			latestReviewId: last.id,
			findings: rows,
			detailsUrl,
			mention,
			images: input.images,
			...extras,
			approvalWithheld: verdict === 'approve' ? null : withheld
		});
	// A review running right now keeps its status line above the rebuilt summary.
	const write = (summaryInput: SummaryInput) =>
		github.upsertMarkedComment(
			pull.pullNumber,
			SUMMARY_MARKER,
			withStatusBlock(formatSummaryComment(summaryInput), status)
		);

	// Approve first, so the summary never claims an approval GitHub does not have. Confirm the
	// head right before: a push since the first read takes the approval back.
	let verdict: Verdict = settled;
	const tier = build('approve').tier;
	if (approves && (await reviewedHead())) {
		verdict = await github
			.createReview({
				pullNumber: pull.pullNumber,
				commitId: last.headSha,
				body: formatReviewBody({
					tier,
					verdict: 'approve',
					blocking: 0,
					comments: 0,
					summaryUrl: existing?.url
				}),
				comments: [],
				event: 'APPROVE'
			})
			.then(
				(): Verdict => 'approve',
				(error: unknown) => {
					input.log.warn('could not approve after settlement', { err: error });
					return settled;
				}
			);
	}
	const summaryInput = build(verdict);
	await write(summaryInput);
	await results.updateGrade(
		{ projectId: pull.projectId, reviewId: last.id },
		{ tier: summaryInput.tier, tierReason: summaryInput.tierReason }
	);
	// No blocking finding is left: withdraw any change request, including one an earlier review
	// left in place. Dismissing finds nothing to do when there is none.
	if (!blockingOpen) {
		await withdrawChangeRequests(connection, pull.pullNumber, CHANGE_REQUEST_DISMISSAL, input.log);
	}
	// The check run follows the new standing, so a required check stops holding the merge back.
	if (current && (verdict !== reviewed || summaryInput.tier !== last.tier)) {
		const checkRunId = await github.startCheckRun({
			headSha: last.headSha,
			name: CHECK_NAME,
			detailsUrl,
			ownAppId: app.id
		});
		await github.completeCheckRun(checkRunId, {
			conclusion: checkConclusions[verdict],
			title: `Tier ${summaryInput.tier}: ${tierMeaning[summaryInput.tier]}`,
			summary: absolutizeLinks(
				[summaryInput.tierReason, last.summary].filter(Boolean).join('\n\n'),
				input.repository,
				last.headSha
			)
		});
	}
}

/** How many findings a settlement reads. */
const FINDINGS_LIMIT = 200;

function sameSha(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** Whether a finding at or above the blocking severity is still open on the pull request. */
export function hasBlockingOpen(
	findings: Pick<FindingRow, 'status' | 'severity'>[],
	blockingSeverity: Severity | null
): boolean {
	if (blockingSeverity === null) return false;
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
		images?: string;
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
		approvesWhenSettled: input.approvesWhenSettled,
		detailsUrl: input.detailsUrl,
		mention: input.mention,
		images: input.images
	};
}
