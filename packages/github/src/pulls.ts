import { RequestError, type Octokit } from 'octokit';

// hansi.codes' GitHub helpers, kept as they are there so both post the same thing.

export interface RepoRef {
	owner: string;
	repo: string;
}

export function parseFullName(fullName: string): RepoRef {
	const [owner, repo] = fullName.split('/');
	if (!owner || !repo) throw new Error(`Invalid repository name: ${fullName}`);
	return { owner, repo };
}

export async function getPullRequest(octokit: Octokit, ref: RepoRef, pullNumber: number) {
	const { data } = await octokit.rest.pulls.get({ ...ref, pull_number: pullNumber });
	return {
		number: data.number,
		title: data.title,
		body: data.body ?? '',
		author: data.user?.login ?? 'unknown',
		authorAssociation: data.author_association,
		draft: data.draft ?? false,
		state: data.state,
		/** True once the pull request has been merged. Closed-without-merge stays false. */
		merged: data.merged,
		baseRef: data.base.ref,
		baseSha: data.base.sha,
		headSha: data.head.sha,
		cloneUrl: data.base.repo.clone_url
	};
}

export type PullRequest = Awaited<ReturnType<typeof getPullRequest>>;

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Whether the PR author can write to the repository. The author association is checked first;
 * members with private org membership can show up as CONTRIBUTOR there, so anyone else is
 * checked against their actual repository permission. Errors count as untrusted.
 */
export async function isTrustedAuthor(
	octokit: Octokit,
	ref: RepoRef,
	pr: { author: string; authorAssociation: string }
): Promise<boolean> {
	if (TRUSTED_ASSOCIATIONS.has(pr.authorAssociation)) return true;
	return hasWriteAccess(octokit, ref, pr.author);
}

/** Reads a file at a ref, or `null` when it does not exist. */
export async function getFileContent(
	octokit: Octokit,
	ref: RepoRef,
	path: string,
	gitRef: string
): Promise<string | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ ...ref, path, ref: gitRef });
		if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
		return Buffer.from(data.content, 'base64').toString('utf8');
	} catch (error) {
		if (error instanceof RequestError && error.status === 404) return null;
		throw error;
	}
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewComment {
	path: string;
	/** Right-side line in the new file; must be part of the diff. */
	line: number;
	startLine?: number;
	body: string;
}

/**
 * Posts all comments as a single review. One request instead of one per comment keeps us clear
 * of GitHub's secondary rate limits and notifies the author once.
 */
export async function createReview(
	octokit: Octokit,
	ref: RepoRef,
	input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		/** Approve, request changes, or only comment. */
		event: ReviewEvent;
	}
) {
	const { data } = await octokit.rest.pulls.createReview({
		...ref,
		pull_number: input.pullNumber,
		commit_id: input.commitId,
		event: input.event,
		body: input.body,
		comments: input.comments.map((comment) => ({
			path: comment.path,
			line: comment.line,
			side: 'RIGHT' as const,
			...(comment.startLine && comment.startLine < comment.line
				? { start_line: comment.startLine, start_side: 'RIGHT' as const }
				: {}),
			body: comment.body
		}))
	});
	return data;
}

/**
 * Comments on a whole file rather than a line. GitHub takes these on files it shows no diff for,
 * where it rejects line comments. Returns the comment id, the root of a thread people can reply in.
 */
export async function createFileComment(
	octokit: Octokit,
	ref: RepoRef,
	input: { pullNumber: number; commitId: string; path: string; body: string }
): Promise<number> {
	const { data } = await octokit.rest.pulls.createReviewComment({
		...ref,
		pull_number: input.pullNumber,
		commit_id: input.commitId,
		path: input.path,
		subject_type: 'file',
		body: input.body
	});
	return data.id;
}

/**
 * The pull request's files as GitHub shows them. `patch` is missing when GitHub does not render
 * the file's diff: a binary file, a file too large to diff, or one past the pull request's diff
 * limit. GitHub rejects inline comments on those, and one rejected comment fails the whole review.
 */
export async function listPullRequestPatches(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number
): Promise<{ path: string; patch?: string }[]> {
	const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
		...ref,
		pull_number: pullNumber,
		per_page: 100
	});
	return files.map((file) => ({ path: file.filename, patch: file.patch || undefined }));
}

/**
 * Dismisses the bot's own "changes requested" reviews on a pull request. A later COMMENT review
 * does not clear that state on GitHub; only an approval or a dismissal does. Returns how many
 * reviews it dismissed, so calling it when there is nothing to dismiss is harmless.
 */
export async function dismissChangeRequests(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number,
	input: { botLogin: string; message: string }
): Promise<number> {
	const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
		...ref,
		pull_number: pullNumber,
		per_page: 100
	});
	const login = input.botLogin.toLowerCase();
	const open = reviews.filter(
		(r) => r.state === 'CHANGES_REQUESTED' && r.user?.login.toLowerCase() === login
	);
	for (const review of open) {
		await octokit.rest.pulls.dismissReview({
			...ref,
			pull_number: pullNumber,
			review_id: review.id,
			message: input.message
		});
	}
	return open.length;
}

export async function createIssueComment(
	octokit: Octokit,
	ref: RepoRef,
	issueNumber: number,
	body: string
) {
	await octokit.rest.issues.createComment({ ...ref, issue_number: issueNumber, body });
}

/**
 * Starts the app's check run on a commit. A run the app left in progress there (a worker that
 * died mid-review) is taken over instead of left spinning next to the new one.
 */
export async function startCheckRun(
	octokit: Octokit,
	ref: RepoRef,
	input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		ownAppId?: string;
		output?: { title: string; summary: string };
	}
) {
	const fields = {
		status: 'in_progress' as const,
		details_url: input.detailsUrl,
		started_at: new Date().toISOString(),
		...(input.output ? { output: input.output } : {})
	};
	if (input.ownAppId) {
		const { data: runs } = await octokit.rest.checks.listForRef({
			...ref,
			ref: input.headSha,
			check_name: input.name,
			per_page: 100
		});
		const orphan = runs.check_runs.find(
			(run) => run.status !== 'completed' && String(run.app?.id) === input.ownAppId
		);
		if (orphan) {
			await octokit.rest.checks.update({ ...ref, check_run_id: orphan.id, ...fields });
			return orphan.id;
		}
	}
	const { data } = await octokit.rest.checks.create({
		...ref,
		name: input.name,
		head_sha: input.headSha,
		...fields
	});
	return data.id;
}

/** Updates what an in-progress check run says, without completing it. */
export async function updateCheckRun(
	octokit: Octokit,
	ref: RepoRef,
	checkRunId: number,
	output: { title: string; summary: string }
) {
	await octokit.rest.checks.update({ ...ref, check_run_id: checkRunId, output });
}

/** Edits an issue comment's body. */
export async function updateIssueComment(
	octokit: Octokit,
	ref: RepoRef,
	commentId: number,
	body: string
) {
	await octokit.rest.issues.updateComment({ ...ref, comment_id: commentId, body });
}

export async function completeCheckRun(
	octokit: Octokit,
	ref: RepoRef,
	checkRunId: number,
	input: {
		conclusion: 'success' | 'neutral' | 'failure' | 'skipped' | 'cancelled';
		title: string;
		summary: string;
	}
) {
	await octokit.rest.checks.update({
		...ref,
		check_run_id: checkRunId,
		status: 'completed',
		conclusion: input.conclusion,
		completed_at: new Date().toISOString(),
		output: { title: input.title, summary: input.summary }
	});
}

/** Review comments GitHub created for a review, to link findings to their comment ids. */
export async function listReviewComments(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number,
	reviewId: number
) {
	return octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
		...ref,
		pull_number: pullNumber,
		review_id: reviewId,
		per_page: 100
	});
}

export interface ThreadComment {
	id: number;
	author: string;
	body: string;
	isBot: boolean;
	path?: string;
	line?: number | null;
	diffHunk?: string;
}

/** A review comment thread: the root comment and its replies, oldest first. */
export async function getReviewThread(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number,
	rootCommentId: number
): Promise<ThreadComment[]> {
	const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
		...ref,
		pull_number: pullNumber,
		per_page: 100
	});
	return comments
		.filter((c) => c.id === rootCommentId || c.in_reply_to_id === rootCommentId)
		.sort((a, b) => a.created_at.localeCompare(b.created_at))
		.map((c) => ({
			id: c.id,
			author: c.user?.login ?? 'unknown',
			body: c.body,
			isBot: c.user?.type === 'Bot',
			path: c.path,
			line: c.line ?? c.original_line ?? null,
			diffHunk: c.diff_hunk
		}));
}

/**
 * The most recent conversation comments on a pull request, oldest first. With `untilId`, the most
 * recent ones up to and including that comment (comment ids only grow).
 */
export async function getRecentIssueComments(
	octokit: Octokit,
	ref: RepoRef,
	issueNumber: number,
	limit = 20,
	untilId?: number
): Promise<ThreadComment[]> {
	const comments = await octokit.paginate(octokit.rest.issues.listComments, {
		...ref,
		issue_number: issueNumber,
		per_page: 100
	});
	const upTo = untilId === undefined ? comments : comments.filter((c) => c.id <= untilId);
	return upTo.slice(-limit).map((c) => ({
		id: c.id,
		author: c.user?.login ?? 'unknown',
		body: c.body ?? '',
		isBot: c.user?.type === 'Bot'
	}));
}

export async function replyToReviewComment(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number,
	commentId: number,
	body: string
) {
	await octokit.rest.pulls.createReplyForReviewComment({
		...ref,
		pull_number: pullNumber,
		comment_id: commentId,
		body
	});
}

interface ReviewThreadsPage {
	repository: {
		pullRequest: {
			reviewThreads: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: {
					id: string;
					isResolved: boolean;
					resolvedBy?: { login: string } | null;
					comments: { nodes: { databaseId: number }[] };
				}[];
			};
		} | null;
	};
}

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	/** Who resolved the thread, when it is resolved and GitHub still knows the account. */
	resolvedBy: string | null;
	/** Database id of the thread's first comment, which is how findings are linked. */
	rootCommentId: number | undefined;
}

/** Every review thread on a pull request. GitHub only exposes threads through GraphQL. */
export async function listReviewThreads(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number
): Promise<ReviewThread[]> {
	const threads: ReviewThread[] = [];
	for (let cursor: string | null = null; ;) {
		const page: ReviewThreadsPage = await octokit.graphql(
			`query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
				repository(owner: $owner, name: $repo) {
					pullRequest(number: $number) {
						reviewThreads(first: 100, after: $cursor) {
							pageInfo { hasNextPage endCursor }
							nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { databaseId } } }
						}
					}
				}
			}`,
			{ ...ref, number: pullNumber, cursor }
		);
		const connection = page.repository.pullRequest?.reviewThreads;
		if (!connection) break;
		for (const thread of connection.nodes) {
			threads.push({
				id: thread.id,
				isResolved: thread.isResolved,
				resolvedBy: thread.resolvedBy?.login ?? null,
				rootCommentId: thread.comments.nodes[0]?.databaseId
			});
		}
		if (!connection.pageInfo.hasNextPage) break;
		cursor = connection.pageInfo.endCursor;
	}
	return threads;
}

/**
 * Resolves the review threads that start with the given comments, e.g. findings that were fixed.
 * Resolving collapses a thread without notifying anyone. Returns how many threads it resolved.
 */
export async function resolveReviewThreads(
	octokit: Octokit,
	ref: RepoRef,
	pullNumber: number,
	rootCommentIds: number[]
): Promise<number> {
	const wanted = new Set(rootCommentIds);
	if (wanted.size === 0) return 0;

	const threadIds = (await listReviewThreads(octokit, ref, pullNumber))
		.filter((t) => !t.isResolved && t.rootCommentId !== undefined && wanted.has(t.rootCommentId))
		.map((t) => t.id);
	for (const threadId of threadIds) {
		await octokit.graphql(
			`mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`,
			{ threadId }
		);
	}
	return threadIds.length;
}

/** Whether an account can write to the repository. Errors count as no. */
export async function hasWriteAccess(
	octokit: Octokit,
	ref: RepoRef,
	username: string
): Promise<boolean> {
	try {
		const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ ...ref, username });
		return data.permission === 'admin' || data.permission === 'write';
	} catch {
		return false;
	}
}

/** Acknowledges a comment with 👀 so people know Hansi is working on it. */
export async function acknowledgeComment(
	octokit: Octokit,
	ref: RepoRef,
	comment: { id: number; kind: 'issue' | 'review' }
) {
	if (comment.kind === 'issue') {
		await octokit.rest.reactions.createForIssueComment({
			...ref,
			comment_id: comment.id,
			content: 'eyes'
		});
	} else {
		await octokit.rest.reactions.createForPullRequestReviewComment({
			...ref,
			comment_id: comment.id,
			content: 'eyes'
		});
	}
}

/** The bot's marked comment on an issue, if one exists. */
export async function getMarkedComment(
	octokit: Octokit,
	ref: RepoRef,
	issueNumber: number,
	marker: string
): Promise<{ id: number; url: string; body: string } | null> {
	const comments = await octokit.paginate(octokit.rest.issues.listComments, {
		...ref,
		issue_number: issueNumber,
		per_page: 100
	});
	const existing = comments.find((c) => c.user?.type === 'Bot' && c.body?.includes(marker));
	return existing?.body ? { id: existing.id, url: existing.html_url, body: existing.body } : null;
}

/**
 * Creates the comment on first use and edits it afterwards, found by a hidden marker in its body,
 * so a pull request always has exactly one summary from the bot.
 */
export async function upsertMarkedComment(
	octokit: Octokit,
	ref: RepoRef,
	issueNumber: number,
	marker: string,
	body: string
): Promise<{ id: number; url: string }> {
	const existing = await getMarkedComment(octokit, ref, issueNumber, marker);
	if (existing) {
		const { data } = await octokit.rest.issues.updateComment({
			...ref,
			comment_id: existing.id,
			body
		});
		return { id: data.id, url: data.html_url };
	}
	const { data } = await octokit.rest.issues.createComment({
		...ref,
		issue_number: issueNumber,
		body
	});
	return { id: data.id, url: data.html_url };
}

const MAX_LINKED_ISSUES = 3;
const MAX_ISSUE_BODY_CHARS = 4_000;

interface ClosingIssuesPage {
	repository: {
		pullRequest: {
			closingIssuesReferences: {
				nodes: {
					number: number;
					title: string;
					body: string;
					repository: { nameWithOwner: string };
				}[];
			};
		} | null;
	};
}

/**
 * Issues a pull request resolves, from closing keywords ("Fixes #12") or the sidebar link. Only
 * issues in the same repository: one from another private repository could leak into the review.
 */
export async function getLinkedIssues(octokit: Octokit, ref: RepoRef, pullNumber: number) {
	const page: ClosingIssuesPage = await octokit.graphql(
		`query($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) {
					closingIssuesReferences(first: 10) {
						nodes { number title body repository { nameWithOwner } }
					}
				}
			}
		}`,
		{ ...ref, number: pullNumber }
	);
	const fullName = `${ref.owner}/${ref.repo}`.toLowerCase();
	return (page.repository.pullRequest?.closingIssuesReferences.nodes ?? [])
		.filter((issue) => issue.repository.nameWithOwner.toLowerCase() === fullName)
		.slice(0, MAX_LINKED_ISSUES)
		.map((issue) => ({
			number: issue.number,
			title: issue.title,
			body: truncate(issue.body, MAX_ISSUE_BODY_CHARS)
		}));
}

const MAX_FAILED_CHECKS = 5;
const MAX_CHECK_OUTPUT_CHARS = 3_000;
const MAX_CHECK_ANNOTATIONS = 20;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * Check runs that already failed on a commit, with their output and annotations, excluding the
 * app's own. Checks still running are left out: a review starts as soon as a PR is pushed, so
 * CI has often not finished yet.
 */
export async function getFailedChecks(
	octokit: Octokit,
	ref: RepoRef,
	headSha: string,
	ownAppId: string
) {
	const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
		...ref,
		ref: headSha,
		filter: 'latest',
		per_page: 100
	});
	const failed = runs
		.filter(
			(run) =>
				run.status === 'completed' &&
				FAILED_CONCLUSIONS.has(run.conclusion ?? '') &&
				String(run.app?.id) !== ownAppId
		)
		.slice(0, MAX_FAILED_CHECKS);

	return Promise.all(
		failed.map(async (run) => {
			const annotations = run.output.annotations_count
				? await octokit.rest.checks
						.listAnnotations({ ...ref, check_run_id: run.id, per_page: 100 })
						.then(({ data }) => data)
				: [];
			return {
				name: run.name,
				conclusion: run.conclusion ?? 'failure',
				output: truncate(
					[run.output.title, run.output.summary, run.output.text].filter(Boolean).join('\n\n'),
					MAX_CHECK_OUTPUT_CHARS
				),
				annotations: annotations
					.filter((a) => a.annotation_level !== 'notice')
					.slice(0, MAX_CHECK_ANNOTATIONS)
					.map((a) => ({ path: a.path, line: a.start_line, message: a.message ?? '' }))
			};
		})
	);
}

function truncate(text: string | null | undefined, max: number): string {
	const trimmed = (text ?? '').trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n… truncated` : trimmed;
}
