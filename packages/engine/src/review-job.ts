import type { LanguageModel } from 'ai';
import { checkout } from './checkout';
import { SandboxSession } from './commands';
import { CONFIG_FILES, parseConfig, type RepoConfig } from './config';
import type { EngineContext } from './context';
import { parseGitDiff } from './diff';
import { git, isMissingPath } from './git';
import type { GitHubClient, PullRequest, ReviewEvent } from './github';
import type { ReviewJob } from './jobs';
import { renderFinding, renderReviewBody } from './render';
import type { ModelUsage, ReviewRef, TraceEvent } from './results';
import { runReview } from './review';
import type { Verdict } from './grading';

// One review job, from the queued pull request to the review on GitHub and the outcome in
// Appwrite. Every skip and failure is reported to the results sink, so a review never stays
// in progress.

/** The check run the review reports on the commit. */
export const CHECK_NAME = 'Hansi';

/** Authors who can push to the repository. Only their pull requests are approved by default. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const reviewEvent: Record<Verdict, ReviewEvent> = {
	approve: 'APPROVE',
	request_changes: 'REQUEST_CHANGES',
	comment: 'COMMENT'
};

export interface ReviewJobOptions {
	reviewer: LanguageModel;
	verifier?: LanguageModel;
	signal?: AbortSignal;
}

/** Why the pull request is not reviewed, or null to review it. */
export function skipReason(
	job: ReviewJob,
	pr: PullRequest,
	config: RepoConfig | null
): string | null {
	const asked = job.trigger.kind === 'mention' || job.trigger.kind === 'retry';
	if (pr.state === 'closed') return 'The pull request is closed.';
	// A push queued a newer review. A mention or retry reviews whatever the head is now.
	if (!asked && pr.head.sha !== job.headSha) return 'A newer commit was pushed.';
	if (!config) return null;
	if (!config.reviews.enabled) return 'Reviews are turned off for this repository.';
	if (!asked && !config.reviews.auto) return 'Automatic reviews are turned off.';
	if (!asked && pr.draft && !config.reviews.drafts) return 'The pull request is a draft.';
	const branches = config.reviews.baseBranches;
	if (branches.length && !branches.includes(pr.base.ref)) {
		return `Pull requests into ${pr.base.ref} are not reviewed.`;
	}
	return null;
}

/** The repository's settings at `ref`, from the first config file that exists. */
async function readConfig(
	dir: string,
	ref: string,
	token?: string
): Promise<{ config: RepoConfig; errors: string[] }> {
	for (const file of CONFIG_FILES) {
		try {
			return parseConfig(await git(['show', `${ref}:${file}`], { cwd: dir, token }));
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
	}
	return parseConfig(null);
}

export async function runReviewJob(
	job: ReviewJob,
	context: EngineContext,
	options: ReviewJobOptions
): Promise<void> {
	const ref: ReviewRef = { projectId: job.repository.projectId, reviewId: job.reviewId };
	const github = await context.github.forRepository(job.repository);
	const pr = await github.getPullRequest(job.pullNumber);

	const early = skipReason(job, pr, null);
	if (early) return context.results.skipReview(ref, early);

	const remote = await github.gitRemote();
	const tree = await checkout(
		remote,
		{ headSha: pr.head.sha, baseSha: pr.base.sha },
		options.signal
	);
	const events: TraceEvent[] = [];
	const usage: ModelUsage[] = [];
	const emit = (type: string, data: Record<string, unknown> = {}) =>
		events.push({ type, at: new Date(), data });
	let checkRun: number | null = null;
	let sandbox: SandboxSession | null = null;
	try {
		// Settings come from the base, so the pull request cannot change how it is reviewed.
		const { config, errors } = await readConfig(tree.dir, pr.base.sha, remote.token);
		const skip = skipReason(job, pr, config);
		if (skip) return await context.results.skipReview(ref, skip);

		await context.results.startReview(ref, { headSha: pr.head.sha, baseSha: pr.base.sha });
		checkRun = await startCheck(github, pr.head.sha, events);

		// The diff comes from the checkout, not GitHub's file list: a push while the job runs
		// would make that list describe a newer head than the one reviewed and commented on.
		const files = parseGitDiff(
			await git(
				[
					// Unquoted paths: parseGitDiff reads them as they are.
					'-c',
					'core.quotePath=false',
					'diff',
					'--no-color',
					'--no-ext-diff',
					'--find-renames',
					'--src-prefix=a/',
					'--dst-prefix=b/',
					`${pr.base.sha}...${pr.head.sha}`
				],
				{ cwd: tree.dir, token: remote.token, signal: options.signal }
			)
		);
		// Started on the agent's first command, from the head the review comments on.
		sandbox = new SandboxSession(
			async () => context.sandboxes.create({ archiveUrl: await github.getArchiveUrl(pr.head.sha) }),
			{ setup: config.sandbox.setup, emit }
		);
		const result = await runReview(
			{
				repoDir: tree.dir,
				baseSha: pr.base.sha,
				token: remote.token,
				pullRequest: { title: pr.title, body: pr.body, author: pr.author },
				files,
				config,
				// Earlier findings come from the results store once it keeps them.
				openFindings: [],
				alreadyReported: [],
				trustedAuthor: TRUSTED_ASSOCIATIONS.has(pr.authorAssociation)
			},
			{
				reviewer: options.reviewer,
				verifier: options.verifier,
				sandbox,
				signal: options.signal,
				emit,
				usage: (entry) => usage.push(entry)
			}
		);

		// The marker finds this review again when a retry runs after it was posted.
		const marker = `<!-- hansi:review ${job.reviewId} -->`;
		const body = `${renderReviewBody(result, { config, configErrors: errors })}\n\n${marker}`;
		const earlier = (await github.listReviews(pr.number)).find((r) => r.body.includes(marker));
		const posted =
			earlier ??
			(await github.createReview(pr.number, {
				commitId: pr.head.sha,
				event: reviewEvent[result.verdict],
				body,
				comments: result.findings.map((finding) => ({
					path: finding.path,
					line: finding.endLine,
					startLine: finding.startLine === finding.endLine ? undefined : finding.startLine,
					side: 'RIGHT',
					body: renderFinding(finding)
				}))
			}));

		// Buffers are cleared only once written, so a failed write still reaches the catch below.
		await context.results.recordEvents(ref, [...events]);
		events.length = 0;
		await context.results.recordUsage(ref, [...usage]);
		usage.length = 0;
		await context.results.completeReview(ref, {
			verdict: result.verdict,
			tier: result.tier,
			summary: result.summary,
			findings: result.findings.map(({ suggestion: _, ...finding }) => finding),
			providerReviewId: posted.id
		});
		await finishCheck(github, checkRun, {
			status: 'completed',
			conclusion: result.verdict === 'request_changes' ? 'failure' : 'success',
			title: `Tier ${result.tier}`,
			summary: result.summary
		});
	} catch (error) {
		await finishCheck(github, checkRun, {
			status: 'completed',
			conclusion: 'neutral',
			title: 'The review could not be completed'
		});
		// What the review got through is still worth keeping; the failure itself is the worker's.
		await Promise.allSettled([
			events.length ? context.results.recordEvents(ref, events) : undefined,
			usage.length ? context.results.recordUsage(ref, usage) : undefined
		]);
		throw error;
	} finally {
		await sandbox?.close().catch(() => {});
		await tree.remove();
	}
}

/** Check runs are a courtesy: an installation without the permission still gets its review. */
async function startCheck(
	github: GitHubClient,
	headSha: string,
	events: TraceEvent[]
): Promise<number | null> {
	try {
		const { id } = await github.createCheckRun({
			name: CHECK_NAME,
			headSha,
			status: 'in_progress',
			title: 'Reviewing'
		});
		return id;
	} catch (error) {
		events.push({
			type: 'check.unavailable',
			at: new Date(),
			data: { error: error instanceof Error ? error.message : String(error) }
		});
		return null;
	}
}

async function finishCheck(
	github: GitHubClient,
	id: number | null,
	run: Parameters<GitHubClient['updateCheckRun']>[1]
): Promise<void> {
	if (id === null) return;
	await github.updateCheckRun(id, run).catch(() => {});
}
