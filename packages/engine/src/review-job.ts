import {
	blockingSeverity,
	parseRepoConfig,
	REPO_CONFIG_FILE,
	severityAtLeast,
	tierMeaning,
	type RepoConfig,
	type Severity,
	type Verdict
} from './config';
import type { Attempt, EngineContext, Log } from './context';
import type { Finding } from './findings';
import {
	absolutizeLinks,
	formatBodyFindings,
	formatFileFindingComment,
	formatFindingComment,
	formatReviewBody,
	formatSummaryComment,
	SUMMARY_MARKER
} from './format';
import { checkoutPullRequest, mergeSecondParent, pullRequestDelta } from './git';
import {
	isUnprocessable,
	type GitHubConnection,
	type PullRequest,
	type ReviewEvent
} from './github';
import type { ReviewJob } from './jobs';
import {
	carriedReview,
	carriedSummaryInput,
	decideIncrementalReview,
	settledCarriedReview,
	type IncrementalDecision
} from './merge-only';
import {
	acknowledgeReviewMention,
	closedPullRequestSkip,
	configuredReviewSkip,
	configuredSkipSummary,
	mentionSkipReply,
	postMentionReply,
	reviewMentionComment,
	type MentionSkipReason
} from './mention-ack';
import { checkRunProgress, createReviewProgress, type ReviewProgress } from './progress';
import { REVIEW_FAILURE_SUMMARY } from './public-failure';
import { dismissFindingsResolvedOnGitHub } from './resolved-threads';
import type {
	FindingOutcome,
	ModelUsage,
	PullRef,
	ResultsSink,
	ReviewRef,
	TraceEvent
} from './results';
import { placeOnGitHubDiff, runReview, type OpenFinding } from './review';
import { openSandbox, type ReviewSandbox } from './review-sandbox';
import {
	mentionWantsSameHeadReply,
	otherPullReviews,
	sameHeadCoalesce,
	sameHeadSkipSummary
} from './same-head';
import {
	lastCompleted,
	modelUsage,
	reviewDetailsUrl,
	withdrawChangeRequests,
	withWorkdir
} from './shared';
import {
	CHANGE_REQUEST_DISMISSAL,
	shouldDismissChangeRequest,
	shouldSubmitReview,
	submissionForCurrentHead
} from './submit-review';
import { summaryExtrasFromBody, summaryFindings } from './summary';
import type { ReviewEvent as TraceStep } from './tools';

// One review job, from the queued pull request to the review on GitHub and the outcome in
// Appwrite. It follows hansi.codes' worker step for step; Appwrite's Reviews API stands in for
// hansi.codes' database.

/** The check run the review reports on the commit. */
export const CHECK_NAME = 'Hansi';

type Outcome = { status: 'skipped'; summary: string; headSha?: string } | { status: 'completed' };

const reviewEvents = {
	approve: 'APPROVE',
	request_changes: 'REQUEST_CHANGES',
	comment: 'COMMENT'
} as const satisfies Record<Verdict, ReviewEvent>;

/** The check run follows the verdict, so teams can require it for merging. */
const checkConclusions = {
	approve: 'success',
	request_changes: 'failure',
	comment: 'neutral'
} as const;

/** The trigger as hansi.codes names it, for the decisions that depend on it. */
function triggerOf(job: ReviewJob): string {
	return job.trigger.kind;
}

export async function runReviewJob(
	job: ReviewJob,
	context: EngineContext,
	attempt: Attempt,
	signal?: AbortSignal
): Promise<void> {
	const { results } = context;
	const ref: ReviewRef = { projectId: job.repository.projectId, reviewId: job.reviewId };
	const pull: PullRef = {
		projectId: job.repository.projectId,
		repositoryId: job.repository.repositoryId,
		pullNumber: job.pullNumber
	};
	const log = context.log;

	const self = (await results.listReviews(pull)).find((review) => review.id === job.reviewId);
	if (self && ['superseded', 'completed', 'skipped', 'failed'].includes(self.status)) {
		log.info('review no longer pending, skipping', { status: self.status });
		return;
	}

	const outcome = await executeReview(job, context, ref, pull, attempt, signal);
	if (outcome.status === 'skipped') {
		await results.skipReview(ref, outcome.summary, outcome.headSha);
	}
	log.info('review finished', { status: outcome.status });
}

/**
 * Records a skip. When a mention asked for the review, also posts the one-line explanation.
 * The reply uses the same comment path as a head that was already reviewed.
 */
async function skipForMention(
	connection: GitHubConnection,
	job: ReviewJob,
	pullNumber: number,
	reason: MentionSkipReason,
	fallback: string,
	log: Log,
	detail?: { baseRef?: string }
): Promise<Outcome> {
	const reply = mentionSkipReply(triggerOf(job), reason, detail);
	if (reply) {
		await postMentionReply(
			(body) => connection.github.createIssueComment(pullNumber, body),
			reply,
			log,
			'could not reply that this review was skipped'
		);
	}
	return { status: 'skipped', summary: reply ?? fallback };
}

async function executeReview(
	job: ReviewJob,
	context: EngineContext,
	ref: ReviewRef,
	pull: PullRef,
	attempt: Attempt,
	signal?: AbortSignal
): Promise<Outcome> {
	const { results, log } = context;
	const connection = await context.github.forRepository(job.repository);
	const { github, app } = connection;
	const mention = `@${app.slug}`;
	const repository = `${job.repository.owner}/${job.repository.name}`;
	const trigger = triggerOf(job);

	// Before any skip, including a mention of a commit that is already reviewed, so the comment
	// shows 👀 as soon as the job starts. A failed reaction must not fail the review.
	const asked = reviewMentionComment(job);
	if (asked && attempt.attempts === 1) {
		await acknowledgeReviewMention(() => github.acknowledgeComment(asked), log);
	}

	const pr = await github.getPullRequest(job.pullNumber);
	const unavailable = closedPullRequestSkip(pr);
	if (unavailable) {
		const summary = unavailable === 'merged' ? 'Pull request is merged' : 'Pull request is closed';
		return skipForMention(connection, job, pr.number, unavailable, summary, log);
	}

	// Configuration comes from the base branch: a pull request must not rewrite its own review
	// rules. Changes to .hansi.json apply once they are merged.
	const { config, ...configResult } = parseRepoConfig(
		await github.getFileContent(REPO_CONFIG_FILE, pr.baseSha)
	);
	const configSkip = configuredReviewSkip({
		trigger,
		enabled: config.reviews.enabled,
		auto: config.reviews.auto,
		draft: pr.draft,
		reviewDrafts: config.reviews.drafts,
		baseBranches: config.reviews.baseBranches,
		baseRef: pr.baseRef
	});
	if (configSkip === 'automatic-disabled') {
		return { status: 'skipped', summary: configuredSkipSummary(configSkip, pr.baseRef) };
	}
	if (configSkip) {
		return skipForMention(
			connection,
			job,
			pr.number,
			configSkip,
			configuredSkipSummary(configSkip, pr.baseRef),
			log,
			{ baseRef: pr.baseRef }
		);
	}

	// A follow-up trigger (a mention while this commit is in review, or another event after it
	// finished) would otherwise run next and submit again. Skip when this commit is already
	// covered. A new commit has a different head and still runs, and an explicit `@slug review`
	// re-reviews a commit that was already reviewed.
	const reviews = await results.listReviews(pull);
	const covered = sameHeadCoalesce(pr.headSha, otherPullReviews(reviews, job.reviewId), trigger);
	if (covered) {
		const summary = sameHeadSkipSummary(covered, pr.headSha);
		log.info('commit already reviewed, skipping', { reason: covered, headSha: pr.headSha });
		if (mentionWantsSameHeadReply(trigger)) {
			await postMentionReply(
				(body) => github.createIssueComment(pr.number, body),
				summary,
				log,
				'could not reply that this commit is already reviewed'
			);
		}
		return { status: 'skipped', summary, headSha: pr.headSha };
	}

	// A redelivery of a review that already ended.
	if (!(await results.startReview(ref, { headSha: pr.headSha, baseSha: pr.baseSha }))) {
		log.info('review already ended, skipping');
		return { status: 'completed' };
	}

	const detailsUrl = reviewDetailsUrl(job.repository.consoleUrl, ref.projectId, ref.reviewId);
	const checkRunId = await github.startCheckRun({
		headSha: pr.headSha,
		name: CHECK_NAME,
		detailsUrl,
		ownAppId: app.id,
		output: checkRunProgress({ kind: 'preparing' })
	});
	// The check run and the summary comment follow the review's phases while it runs.
	const progress = createReviewProgress({
		headSha: pr.headSha,
		mention,
		detailsUrl,
		log,
		updateCheckRun: (output) => github.updateCheckRun(checkRunId, output),
		readSummary: () => github.getMarkedComment(pr.number, SUMMARY_MARKER),
		writeSummary: async (id, body) => {
			if (id) await github.updateIssueComment(id, body);
			else await github.upsertMarkedComment(pr.number, SUMMARY_MARKER, body);
		}
	});

	// Events and usage are written in order, off the model's critical path.
	const events: TraceEvent[] = [];
	const usage: ModelUsage[] = [];
	let pendingWrites: Promise<unknown> = Promise.resolve();
	const flush = () => {
		pendingWrites = pendingWrites
			.then(() => results.recordEvents(ref, events))
			.then(() => results.recordUsage(ref, usage))
			.catch((error: unknown) => log.warn('could not record review events', { err: error }));
		return pendingWrites;
	};
	const record = (event: TraceStep) => {
		events.push({ type: event.type, at: new Date(), data: event.data ?? {} });
		progress.onEvent(event);
		if (event.type !== 'anchoring.suspicious') return;
		log.warn('most findings could not be attached to a changed line', {
			submitted: event.data?.submitted,
			unattached: event.data?.unattached
		});
	};
	if (!configResult.ok) record({ type: 'config.invalid', data: { errors: configResult.errors } });

	try {
		return await withWorkdir(context.workdir, async (repoDir) => {
			const token = await github.getInstallationToken();
			const diff = await checkoutPullRequest({
				dir: repoDir,
				cloneUrl: pr.cloneUrl,
				token,
				pullNumber: pr.number,
				baseSha: pr.baseSha,
				headSha: pr.headSha
			});

			// On a push, review only what this pull request itself changed since the last review.
			// A merge of the base branch is not that: its files belong to main, not to the PR.
			// A thread a maintainer resolved on GitHub settles its finding before the history is read.
			await dismissFindingsResolvedOnGitHub(
				results,
				connection,
				pull,
				await results.listFindings(pull, { limit: 200 }),
				log
			);
			const history = await loadReviewHistory(results, pull, job.reviewId);
			let reviewDiff = diff;
			let incrementalFrom: string | undefined;
			if (trigger === 'synchronize' && history.lastHeadSha) {
				const delta = await pullRequestDelta({
					dir: repoDir,
					baseSha: pr.baseSha,
					lastHead: history.lastHeadSha,
					headSha: pr.headSha,
					token
				});
				const previous = carriedReview({
					id: history.lastReviewId,
					headSha: history.lastHeadSha,
					summary: history.previousSummaryText,
					verdict: history.previousVerdict,
					tier: history.previousTier,
					tierReason: history.previousTierReason,
					walkthrough: history.previousWalkthrough
				});
				const mergedSha =
					delta.status === 'unchanged'
						? ((await mergeSecondParent(repoDir, pr.headSha)) ?? pr.baseSha)
						: pr.baseSha;
				const decision = decideIncrementalReview({
					delta,
					baseRef: pr.baseRef,
					mergedSha,
					sinceSha: history.lastHeadSha,
					previous
				});
				log.info('incremental review range', { delta: delta.status, decision: decision.kind });
				if (decision.kind === 'merge-only') {
					await progress.close();
					return finishMergeOnly({
						results,
						connection,
						ref,
						pull,
						repository,
						consoleUrl: job.repository.consoleUrl,
						checkRunId,
						detailsUrl,
						decision,
						record,
						flush
					});
				}
				if (decision.kind === 'incremental') {
					reviewDiff = decision.diff;
					incrementalFrom = history.lastHeadSha;
				}
			}
			const subagents = context.subagents ?? true;
			if (!subagents) {
				record({ type: 'subagents.off', data: { reason: 'turned off in the service settings' } });
			}
			const learnings = await results.listLearnings(job.repository);
			const { linkedIssues, failedChecks } = await loadPullRequestContext(connection, pr, log);
			record({
				type: 'review.mode',
				data: {
					incremental: !!incrementalFrom,
					from: incrementalFrom ?? pr.baseSha,
					previousFindings: history.findings.length,
					openFindings: history.open.length,
					learnings: learnings.length,
					linkedIssues: linkedIssues.map((i) => i.number),
					failedChecks: failedChecks.map((c) => c.name)
				}
			});

			const sandbox = await reviewSandbox(context, connection, config, pr, record, progress);
			const result = await runReview({
				repoDir,
				diff: reviewDiff,
				pullRequestDiff: diff,
				incrementalFrom,
				previousFindings: history.findings,
				openFindings: history.open,
				previousSummary: history.previousSummary,
				learnings,
				trustedSource: { ref: pr.baseSha, token },
				withholdApproval: await approvalRestriction(connection, pr, config),
				pullRequest: pr,
				linkedIssues,
				failedChecks,
				config,
				models: context.models,
				onEvent: record,
				onModelCall: (call) => {
					usage.push(modelUsage(call));
				},
				signal,
				sandbox: sandbox?.runner,
				limits: subagents ? undefined : { maxSubagents: 0 }
			}).finally(() => sandbox?.close());
			await flush();

			if (result.status === 'skipped') {
				await progress.settle({ kind: 'skipped', reason: result.reason });
				await github.completeCheckRun(checkRunId, {
					conclusion: 'skipped',
					title: 'Skipped',
					summary: result.reason
				});
				return { status: 'skipped', summary: result.reason } satisfies Outcome;
			}

			// Earlier findings the new code fixes are resolved before the verdict is posted.
			if (result.resolved.length) {
				await results.updateFindings(pull, result.resolved, {
					status: 'resolved',
					reason: `Fixed by ${pr.headSha.slice(0, 7)}`
				});
				const fixed = history.rows.filter((f) => result.resolved.includes(f.id));
				// Close their threads on GitHub too. Quietly: the summary lists what was fixed.
				await github
					.resolveReviewThreads(
						pr.number,
						fixed.flatMap((f) => (f.providerCommentId ? [f.providerCommentId] : []))
					)
					.catch((error: unknown) => log.warn('could not resolve fixed threads', { err: error }));
			}

			// The final summary replaces the status block, so no progress write may land after it.
			progress.phase({ kind: 'publishing' });
			await progress.close();

			// One summary comment per PR, edited in place on every review.
			const threshold = blockingSeverity(config);
			const stillOpen = history.open.filter((f) => !result.resolved.includes(f.id));
			// Submit a GitHub review when there are inline comments, the approve/request-changes
			// state changes, the pull request reaches Tier S, or someone explicitly asked for a
			// re-review.
			const plannedSubmit = shouldSubmitReview({
				posted: result.posted.length,
				verdict: result.verdict,
				tier: result.tier,
				previousTier: history.previousTier,
				lastDecisiveVerdict: history.lastDecisiveVerdict,
				trigger
			});
			// The model ran against `pr.headSha`. Re-read the head before publishing so an
			// approval cannot land on a commit the author has already replaced.
			const decide = (currentHeadSha: string) =>
				submissionForCurrentHead({
					reviewedSha: pr.headSha,
					currentHeadSha,
					verdict: result.verdict,
					posted: result.posted.length,
					shouldSubmit: plannedSubmit
				});
			const summaryBody = (decision: ReturnType<typeof decide>) =>
				formatSummaryComment({
					repository,
					// Line links stay on the reviewed commit. The new head may have moved them.
					headSha: pr.headSha,
					summary: result.summary,
					tier: result.tier,
					tierReason: result.tierReason,
					verdict: decision.verdict,
					posted: result.posted,
					resolved: history.open.filter((f) => result.resolved.includes(f.id)),
					// Every open finding, including minors: the grade may rest on them.
					stillOpen,
					dropped: result.dropped,
					walkthrough: result.walkthrough,
					latestChanges: result.latestChanges,
					approvalWithheld: result.approvalWithheld,
					filesTooLargeForPrompt: result.filesTooLargeForPrompt,
					staleHead: decision.note,
					incrementalFrom,
					detailsUrl,
					mention
				});

			let submission = decide((await github.getPullRequest(pr.number)).headSha);
			let summary = await github.upsertMarkedComment(
				pr.number,
				SUMMARY_MARKER,
				summaryBody(submission)
			);
			// Confirm again immediately before a decisive review. The summary write is the only
			// gap after the first read; a move there downgrades the event instead of approving.
			if (submission.submit && submission.verdict !== 'comment') {
				const confirmed = decide((await github.getPullRequest(pr.number)).headSha);
				if (confirmed.headMoved) {
					submission = confirmed;
					summary = await github.upsertMarkedComment(
						pr.number,
						SUMMARY_MARKER,
						summaryBody(submission)
					);
				}
			}
			if (submission.headMoved) {
				log.info('pull request head moved before submit', {
					reviewedSha: pr.headSha,
					submit: submission.submit
				});
			}

			const posted = submission.submit
				? await postReview(
						connection,
						pr,
						repository,
						{
							body: ({ inline, inBody }) =>
								formatReviewBody({
									tier: result.tier,
									verdict: submission.verdict,
									blocking: result.posted.filter((f) => severityAtLeast(f.severity, threshold))
										.length,
									comments: inline,
									inBody,
									summaryUrl: summary.url
								}),
							event: reviewEvents[submission.verdict]
						},
						result.posted,
						log
					)
				: { reviewId: undefined, commentIds: [] };
			// A COMMENT review leaves an earlier "changes requested" in force on GitHub. Withdraw it
			// once nothing blocking is open, or the author stays blocked by fixed findings.
			const blockingOpen =
				result.posted.filter((f) => severityAtLeast(f.severity, threshold)).length +
				result.stillOpenBlocking;
			const dismissedChangeRequests = shouldDismissChangeRequest({
				verdict: submission.verdict,
				blockingOpen,
				lastDecisiveVerdict: history.lastDecisiveVerdict,
				headMoved: submission.headMoved
			})
				? await withdrawChangeRequests(connection, pr.number, CHANGE_REQUEST_DISMISSAL, log)
				: 0;
			record({
				type: 'review.posted',
				data: {
					summaryUrl: summary.url,
					submittedReview: submission.submit,
					headMoved: submission.headMoved,
					dismissedChangeRequests
				}
			});

			const findings: FindingOutcome[] = [
				...result.posted.map((f, i) => ({
					...findingFields(f),
					status: 'posted' as const,
					dropReason: null,
					providerCommentId: posted.commentIds[i] ?? null
				})),
				...result.dropped.map((f) => ({
					...findingFields(f),
					status: 'dropped' as const,
					dropReason: f.dropReason,
					providerCommentId: null
				}))
			];
			await flush();
			await results.completeReview(ref, {
				verdict: submission.verdict,
				tier: result.tier,
				tierReason: result.tierReason,
				summary: result.summary,
				walkthrough: result.walkthrough,
				findings,
				providerReviewId: posted.reviewId
			});

			await github.completeCheckRun(checkRunId, {
				conclusion: checkConclusions[submission.verdict],
				title: submission.headMoved
					? 'Newer commits will be reviewed'
					: `Tier ${result.tier}: ${tierMeaning[result.tier]}`,
				summary: absolutizeLinks(
					[submission.note, result.tierReason, result.summary].filter(Boolean).join('\n\n'),
					repository,
					pr.headSha
				)
			});
			return { status: 'completed' } satisfies Outcome;
		});
	} catch (error) {
		await flush();
		// Never leave the summary saying the review is still running.
		await progress.settle({
			kind: attempt.attempts >= attempt.maxAttempts ? 'failed' : 'retrying'
		});
		await github
			.completeCheckRun(checkRunId, {
				conclusion: 'neutral',
				title: 'Review failed',
				summary: REVIEW_FAILURE_SUMMARY
			})
			.catch((e: unknown) => log.warn('failed to complete check run', { err: e }));
		throw error;
	}
}

function findingFields(f: Finding) {
	return {
		path: f.path,
		startLine: f.startLine,
		endLine: f.endLine,
		severity: f.severity,
		category: f.category,
		title: f.title,
		body: f.body,
		suggestion: f.suggestion ?? null
	};
}

/**
 * What the pull request is meant to do and what CI already knows about it. Both are extras: if
 * GitHub fails to return them, the review goes ahead without.
 */
async function loadPullRequestContext(
	{ github, app }: GitHubConnection,
	pr: { number: number; headSha: string },
	log: Log
) {
	const [linkedIssues, failedChecks] = await Promise.all([
		github.getLinkedIssues(pr.number).catch((error: unknown) => {
			log.warn('could not load linked issues', { err: error });
			return [];
		}),
		github.getFailedChecks(pr.headSha, app.id).catch((error: unknown) => {
			log.warn('could not load failed checks', { err: error });
			return [];
		})
	]);
	return { linkedIssues, failedChecks };
}

/**
 * The sandbox this review runs commands in. It starts before the review. When it cannot start,
 * the failure is recorded and the review reads code only.
 */
async function reviewSandbox(
	context: EngineContext,
	{ github }: GitHubConnection,
	config: RepoConfig,
	pr: PullRequest,
	record: (event: TraceStep) => void,
	progress: ReviewProgress
): Promise<ReviewSandbox | undefined> {
	if (!context.sandboxes) {
		record({ type: 'sandbox.skipped', data: { reason: 'no orchestrator configured' } });
		return undefined;
	}
	progress.phase({ kind: 'sandbox' });
	try {
		return await openSandbox({
			client: context.sandboxes,
			archiveUrl: await github.getArchiveUrl(pr.headSha),
			config,
			emit: record,
			log: context.log
		});
	} catch (error) {
		context.log.warn('sandbox failed to start', { err: error });
		record({ type: 'sandbox.failed', data: { error: (error as Error).message } });
		return undefined;
	}
}

/**
 * Why Hansi may not approve this PR, if anything. Content from people without write access could
 * try to talk the model into approving, so their PRs get findings but never an approval.
 */
async function approvalRestriction(
	{ github }: GitHubConnection,
	pr: { author: string; authorAssociation: string },
	config: RepoConfig
): Promise<string | undefined> {
	if (config.reviews.approveOutsideContributors) return undefined;
	if (await github.isTrustedAuthor(pr)) return undefined;
	return `@${pr.author} does not have write access to this repository, so Hansi does not approve automatically. A maintainer can review and approve.`;
}

/**
 * Posts the review and returns the GitHub comment id for each finding (same order), so replies
 * to a finding can be traced back to it. A finding GitHub would not take inline goes in the
 * review body instead, and its id is null.
 */
async function postReview(
	{ github }: GitHubConnection,
	pr: { number: number; headSha: string },
	repository: string,
	review: { body: (counts: { inline: number; inBody: number }) => string; event: ReviewEvent },
	findings: Finding[],
	log: Log
): Promise<{ reviewId: number | undefined; commentIds: (number | null)[] }> {
	const { event } = review;
	const permalink = { repository, headSha: pr.headSha };

	// Hansi's diff comes from git. GitHub shows less on a large pull request: files past its diff
	// limit have no diff there, and it rejects the whole review for one comment on them.
	const placed = await github.listPullRequestPatches(pr.number).then(
		(files) => placeOnGitHubDiff(findings, files),
		(error: unknown) => {
			log.warn('could not read the pull request files from GitHub', { err: error });
			return findings;
		}
	);
	const inline = placed.flatMap((finding, index) => (finding ? [{ finding, index }] : []));
	const ids: (number | null)[] = findings.map(() => null);

	// A file GitHub shows no diff for still takes a comment on the whole file, which gives the
	// finding a thread to reply in. Only what GitHub refuses there goes in the review body.
	const inBody: Finding[] = [];
	for (const [index, finding] of findings.entries()) {
		if (placed[index]) continue;
		try {
			ids[index] = await github.createFileComment({
				pullNumber: pr.number,
				commitId: pr.headSha,
				path: finding.path,
				body: formatFileFindingComment(finding, permalink)
			});
		} catch (error) {
			if (!isUnprocessable(error)) throw error;
			log.warn('file comment rejected', { err: error, path: finding.path });
			inBody.push(finding);
		}
	}
	const onFiles = findings.length - inline.length - inBody.length;
	if (onFiles || inBody.length) {
		log.warn('findings outside GitHub diff, posting them on their files or in the review body', {
			onFiles,
			inBody: inBody.length,
			inline: inline.length
		});
	}

	const submit = (inlineFindings: typeof inline, bodyFindings: Finding[]) =>
		github.createReview({
			pullNumber: pr.number,
			commitId: pr.headSha,
			body: [
				review.body({ inline: inlineFindings.length + onFiles, inBody: bodyFindings.length }),
				formatBodyFindings(bodyFindings, permalink)
			]
				.filter(Boolean)
				.join('\n\n'),
			comments: inlineFindings.map(({ finding }) => ({
				path: finding.path,
				line: finding.endLine,
				startLine: finding.startLine,
				body: formatFindingComment(finding, permalink)
			})),
			event
		});

	let created: Awaited<ReturnType<typeof submit>>;
	try {
		created = await submit(inline, inBody);
	} catch (error) {
		// GitHub rejects the whole review if one comment position is invalid. Don't lose the
		// findings: fall back to listing them all in the review body.
		if (!isUnprocessable(error) || inline.length === 0) throw error;
		log.warn('inline comments rejected, posting findings in the review body', { err: error });
		const fallback = await submit(
			[],
			findings.filter((_, index) => ids[index] === null)
		);
		return { reviewId: fallback.id, commentIds: ids };
	}
	if (inline.length === 0) return { reviewId: created.id, commentIds: ids };

	const comments = await github.listReviewComments(pr.number, created.id);
	const used = new Set<number>();
	for (const { finding, index } of inline) {
		const body = formatFindingComment(finding, permalink);
		const match =
			comments.find((c) => !used.has(c.id) && c.path === finding.path && c.body === body) ??
			comments.find(
				(c) => !used.has(c.id) && c.path === finding.path && c.line === finding.endLine
			);
		if (!match) continue;
		used.add(match.id);
		ids[index] = match.id;
	}
	return { reviewId: created.id, commentIds: ids };
}

/**
 * The last completed review of this PR, the findings not to repeat (posted and dismissed), and
 * the findings still open.
 */
async function loadReviewHistory(results: ResultsSink, pull: PullRef, reviewId: string) {
	const reviews = (await results.listReviews(pull)).filter((review) => review.id !== reviewId);
	const last = lastCompleted(reviews);
	// Hansi's current approve / request-changes state on GitHub is its latest such review.
	const decisive = lastCompleted(
		reviews.filter((review) => review.verdict === 'approve' || review.verdict === 'request_changes')
	);
	const rows = (await results.listFindings(pull, { limit: 200 })).filter(
		(f) => f.reviewId !== reviewId && f.status !== 'dropped'
	);
	const open: OpenFinding[] = rows
		.filter((f) => f.status === 'posted')
		.map((f) => ({ ...f, severity: f.severity as Severity }));
	// Resolved findings may be reported again if the problem comes back; dismissed ones may not.
	const findings = rows.filter((f) => f.status !== 'resolved');
	return {
		rows,
		lastReviewId: last?.id,
		lastHeadSha: last?.headSha || undefined,
		previousTier: last?.tier,
		previousTierReason: last?.tierReason ?? '',
		previousVerdict: last?.verdict ?? undefined,
		previousSummaryText: last?.summary ?? undefined,
		previousWalkthrough: last?.walkthrough ?? [],
		previousSummary:
			last?.summary && last.walkthrough
				? { summary: last.summary, walkthrough: last.walkthrough }
				: undefined,
		lastDecisiveVerdict: decisive?.verdict ?? undefined,
		findings,
		open
	};
}

/**
 * A merge of the base branch that did not change the pull request. Keep the previous verdict,
 * grade, findings, and walkthrough; rewrite only the summary footer. No model call, no new
 * GitHub review. The check run repeats the previous conclusion.
 */
async function finishMergeOnly(input: {
	results: ResultsSink;
	connection: GitHubConnection;
	ref: ReviewRef;
	pull: PullRef;
	repository: string;
	consoleUrl?: string;
	checkRunId: number;
	detailsUrl?: string;
	decision: Extract<IncrementalDecision, { kind: 'merge-only' }>;
	record: (event: TraceStep) => void;
	flush: () => Promise<unknown>;
}): Promise<Outcome> {
	const { connection, decision } = input;
	const { github, app } = connection;
	const findings = summaryFindings(await input.results.listFindings(input.pull, { limit: 200 }));
	const carried = settledCarriedReview(
		decision.review,
		findings
			.filter((f) => f.status === 'posted')
			.map((f) => ({ severity: f.severity as Severity, title: f.title }))
	);
	input.record({
		type: 'review.mode',
		data: { incremental: true, mergeOnly: true, from: decision.sinceSha }
	});
	input.record({
		type: 'review.merge_only',
		data: {
			baseRef: decision.baseRef,
			mergedSha: decision.mergedSha,
			since: decision.sinceSha,
			verdict: carried.verdict,
			tier: carried.tier,
			submittedReview: false
		}
	});

	const existing = await github.getMarkedComment(input.pull.pullNumber, SUMMARY_MARKER);
	const summaryInput = carriedSummaryInput({
		repository: input.repository,
		mention: `@${app.slug}`,
		detailsUrl: input.detailsUrl,
		scope: decision.scope,
		review: carried,
		findings,
		extras: existing ? summaryExtrasFromBody(existing.body) : {}
	});
	await github.upsertMarkedComment(
		input.pull.pullNumber,
		SUMMARY_MARKER,
		formatSummaryComment(summaryInput)
	);
	await input.flush();
	await input.results.completeReview(input.ref, {
		verdict: carried.verdict,
		tier: carried.tier,
		tierReason: carried.tierReason,
		summary: carried.summary,
		walkthrough: carried.walkthrough,
		findings: []
	});
	await github.completeCheckRun(input.checkRunId, {
		conclusion: checkConclusions[carried.verdict],
		title: `Tier ${carried.tier}: ${tierMeaning[carried.tier]}`,
		summary: absolutizeLinks(
			[carried.tierReason, carried.summary].filter(Boolean).join('\n\n'),
			input.repository,
			carried.headSha
		)
	});
	return { status: 'completed' };
}
