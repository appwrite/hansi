import {
	splitPatches,
	type CheckConclusion,
	type FailedCheckRun,
	type GitCredential,
	type GitHubApp,
	type GitHubClient,
	type GitHubClientFactory,
	type GitHubConnection,
	type LinkedIssueRef,
	type PostedReviewComment,
	type PullRequest,
	type ReviewComment,
	type ReviewEvent,
	type ReviewThread,
	type ThreadComment
} from '@hansi/engine';
import { GiteaApi, GiteaError, type GiteaApiConfig } from './api';

// The engine's client contract on Gitea, whose API follows GitHub's closely: reviews carry their
// comments, pull request heads live at `refs/pull/<n>/head`, and threads hang off their first
// comment. The token is the bot's, held by Appwrite for the repository.
//
// What differs: a review comment sits on one line, never a range or a whole file; Gitea lists a
// review's comments but not a thread's, so a thread is the comments on one line of one file; and
// the check run is a commit status. Replying to and resolving a review comment use endpoints
// only recent Gitea releases have; an older instance answers them 404.

export interface InstallationToken {
	token: string;
	expiresAt: Date;
	/** The bot account: its user id, and the login people mention it by. */
	app: { id: string; slug: string };
	/**
	 * The instance's API root when it is self-hosted, e.g. `https://git.example.com/api/v4`. Wins
	 * over the configured one, since each installation names its own host.
	 */
	endpoint?: string;
}

/** Hands out the bot's token for one repository: the project's `repositories` row. */
export interface InstallationTokens {
	get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken>;
}

/** Renew a token this long before it expires. */
const TOKEN_MARGIN_MS = 2 * 60_000;

const MAX_LINKED_ISSUES = 10;
const MAX_ISSUE_BODY_CHARS = 4_000;
const MAX_FAILED_CHECKS = 5;

const WRITE_PERMISSIONS = new Set(['write', 'admin', 'owner']);
const FAILED_STATES = new Set(['failure', 'error']);
/** The words Gitea closes an issue with when the pull request merges, before `#<n>`. */
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

export class InstallationGiteaClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: GiteaApiConfig = {}
	) {}

	async forRepository(repository: {
		projectId: string;
		repositoryId: string;
		providerRepositoryId?: string;
		owner: string;
		name: string;
	}): Promise<GitHubConnection> {
		const { projectId, repositoryId } = repository;
		let current: InstallationToken = await this.tokens.get({ projectId, repositoryId });
		const token = async () => {
			if (current.expiresAt.getTime() - Date.now() < TOKEN_MARGIN_MS) {
				current = await this.tokens.get({ projectId, repositoryId });
			}
			return current.token;
		};
		const api = new GiteaApi(token, {
			...this.config,
			apiUrl: current.endpoint || this.config.apiUrl
		});
		// Gitea addresses a repository by owner and name only; its id finds them after a rename.
		const found = repository.providerRepositoryId
			? await api.request<Repository>(
					'GET',
					`/repositories/${encodeURIComponent(repository.providerRepositoryId)}`
				)
			: await api.request<Repository>(
					'GET',
					`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
				);
		const path = `/repos/${encodeURIComponent(found.owner.login)}/${encodeURIComponent(found.name)}`;
		const github = new GiteaClient(api, path, token, current.app, found);
		return {
			github,
			app: current.app,
			filesUrl: `${found.html_url.replace(/\/+$/, '')}/src/commit`
		};
	}
}

interface User {
	id: number;
	login: string;
}

interface Repository {
	name: string;
	owner: User;
	html_url: string;
	clone_url: string;
}

interface IssueComment {
	id: number;
	body: string;
	user: User;
	html_url?: string;
}

interface Review {
	id: number;
	body: string;
	user?: User | null;
	state: string;
	dismissed?: boolean;
}

interface ReviewCommentBody {
	id: number;
	body: string;
	user?: User | null;
	path: string;
	position?: number;
	original_position?: number;
	diff_hunk?: string;
	resolver?: User | null;
}

interface Status {
	context: string;
	status: string;
	description?: string;
	target_url?: string;
	creator?: User | null;
}

const events: Record<ReviewEvent, string> = {
	APPROVE: 'APPROVED',
	REQUEST_CHANGES: 'REQUEST_CHANGES',
	COMMENT: 'COMMENT'
};

const states: Record<CheckConclusion, string> = {
	success: 'success',
	neutral: 'success',
	failure: 'failure',
	skipped: 'skipped',
	cancelled: 'error'
};

export class GiteaClient implements GitHubClient {
	/** Statuses are posted whole, so each update repeats what started the run. */
	private readonly checkRuns = new Map<
		string,
		{ headSha: string; context: string; detailsUrl?: string }
	>();

	constructor(
		private readonly api: GiteaApi,
		private readonly path: string,
		private readonly token: () => Promise<string>,
		private readonly app: GitHubApp,
		private readonly repository: Repository
	) {}

	/** Gitea takes a token as the password of its account; the bot's login is that account. */
	async getInstallationToken(): Promise<GitCredential> {
		return { username: this.app.slug, token: await this.token() };
	}

	async getPullRequest(pullNumber: number): Promise<PullRequest> {
		const pr = await this.api.request<{
			number: number;
			title: string;
			body: string;
			user: User;
			draft?: boolean;
			state: string;
			merged: boolean;
			head: { sha: string; repo_id?: number };
			base: { ref: string; sha: string; repo_id?: number };
		}>('GET', `${this.path}/pulls/${pullNumber}`);
		return {
			number: pr.number,
			title: pr.title,
			body: pr.body ?? '',
			author: this.name(pr.user),
			// Gitea has no author association: trust comes from the collaborator permission.
			authorAssociation: '',
			botOnOwnBranch: false,
			draft: pr.draft ?? false,
			state: pr.state,
			merged: pr.merged,
			baseRef: pr.base.ref,
			baseSha: pr.base.sha,
			headSha: pr.head.sha,
			cloneUrl: this.repository.clone_url
		};
	}

	isTrustedAuthor(pr: { author: string }) {
		return this.hasWriteAccess(pr.author);
	}

	async hasWriteAccess(username: string): Promise<boolean> {
		try {
			const { permission } = await this.api.request<{ permission: string }>(
				'GET',
				`${this.path}/collaborators/${encodeURIComponent(username)}/permission`
			);
			return WRITE_PERMISSIONS.has(permission);
		} catch {
			return false;
		}
	}

	async getFileContent(path: string, gitRef: string): Promise<string | null> {
		try {
			const file = path.split('/').map(encodeURIComponent).join('/');
			return await this.api.raw(`${this.path}/raw/${file}`, { ref: gitRef });
		} catch (error) {
			if (error instanceof GiteaError && error.status === 404) return null;
			throw error;
		}
	}

	/** A comment on a range sits on the range's last line, which is where the finding points. */
	async createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: string }> {
		const review = await this.api.request<Review>(
			'POST',
			`${this.path}/pulls/${input.pullNumber}/reviews`,
			{
				body: {
					commit_id: input.commitId,
					event: events[input.event],
					body: input.body,
					comments: input.comments.map((comment) => ({
						path: comment.path,
						new_position: comment.line,
						body: comment.body
					}))
				}
			}
		);
		return { id: String(review.id) };
	}

	/** Gitea comments on lines only. Refused like a line off the diff, so it goes in the body. */
	async createFileComment(input: { path: string }): Promise<string> {
		throw new GiteaError(422, `Gitea has no comments on a whole file (${input.path})`);
	}

	async listPullRequestPatches(pullNumber: number): Promise<{ path: string; patch?: string }[]> {
		return splitPatches(await this.api.raw(`${this.path}/pulls/${pullNumber}.diff`));
	}

	async listReviewComments(pullNumber: number, reviewId: string): Promise<PostedReviewComment[]> {
		const comments = await this.api.request<ReviewCommentBody[]>(
			'GET',
			`${this.path}/pulls/${pullNumber}/reviews/${encodeURIComponent(reviewId)}/comments`
		);
		return comments.map((comment) => ({
			id: String(comment.id),
			path: comment.path,
			line: comment.position || null,
			body: comment.body
		}));
	}

	async dismissChangeRequests(
		pullNumber: number,
		input: { botLogin: string; message: string; only?: (body: string) => boolean }
	): Promise<number> {
		const open = (await this.reviews(pullNumber)).filter(
			(review) =>
				review.state === 'REQUEST_CHANGES' &&
				!review.dismissed &&
				this.isOwn(review.user) &&
				(!input.only || input.only(review.body))
		);
		for (const review of open) {
			await this.api.request(
				'POST',
				`${this.path}/pulls/${pullNumber}/reviews/${review.id}/dismissals`,
				{ body: { message: input.message } }
			);
		}
		return open.length;
	}

	async createIssueComment(issueNumber: number, body: string): Promise<void> {
		await this.api.request('POST', `${this.path}/issues/${issueNumber}/comments`, {
			body: { body }
		});
	}

	async updateIssueComment(commentId: string, body: string): Promise<void> {
		await this.api.request(
			'PATCH',
			`${this.path}/issues/comments/${encodeURIComponent(commentId)}`,
			{ body: { body } }
		);
	}

	async getMarkedComment(
		issueNumber: number,
		marker: string
	): Promise<{ id: string; url: string; body: string } | null> {
		const existing = (await this.issueComments(issueNumber)).find(
			(comment) => this.isOwn(comment.user) && comment.body.includes(marker)
		);
		if (!existing) return null;
		return {
			id: String(existing.id),
			url: this.commentUrl(issueNumber, existing),
			body: existing.body
		};
	}

	async upsertMarkedComment(
		issueNumber: number,
		marker: string,
		body: string
	): Promise<{ id: string; url: string }> {
		const existing = await this.getMarkedComment(issueNumber, marker);
		if (existing) {
			await this.updateIssueComment(existing.id, body);
			return { id: existing.id, url: existing.url };
		}
		const created = await this.api.request<IssueComment>(
			'POST',
			`${this.path}/issues/${issueNumber}/comments`,
			{ body: { body } }
		);
		return { id: String(created.id), url: this.commentUrl(issueNumber, created) };
	}

	/** Gitea keeps review comments with the conversation's, so one endpoint reacts to both. */
	async acknowledgeComment(_pullNumber: number, comment: { id: string }): Promise<void> {
		await this.api.request(
			'POST',
			`${this.path}/issues/comments/${encodeURIComponent(comment.id)}/reactions`,
			{ body: { content: 'eyes' } }
		);
	}

	async getReviewThread(pullNumber: number, rootCommentId: string): Promise<ThreadComment[]> {
		const thread = (await this.threads(pullNumber)).find(
			(comments) => String(comments[0]!.id) === rootCommentId
		);
		return (thread ?? []).map((comment) => ({
			id: String(comment.id),
			author: this.name(comment.user),
			body: comment.body,
			isBot: this.isOwn(comment.user),
			path: comment.path,
			line: comment.position || comment.original_position || null,
			...(comment.diff_hunk ? { diffHunk: comment.diff_hunk } : {})
		}));
	}

	async getRecentIssueComments(
		issueNumber: number,
		limit = 20,
		untilId?: string
	): Promise<ThreadComment[]> {
		const comments = await this.issueComments(issueNumber);
		const until = untilId === undefined ? -1 : comments.findIndex((c) => String(c.id) === untilId);
		const upTo = until === -1 ? comments : comments.slice(0, until + 1);
		return upTo.slice(-limit).map((comment) => ({
			id: String(comment.id),
			author: this.name(comment.user),
			body: comment.body,
			isBot: this.isOwn(comment.user)
		}));
	}

	async replyToReviewComment(pullNumber: number, commentId: string, body: string): Promise<void> {
		await this.api.request(
			'POST',
			`${this.path}/pulls/${pullNumber}/comments/${encodeURIComponent(commentId)}/replies`,
			{ body: { body } }
		);
	}

	async listReviewThreads(pullNumber: number): Promise<ReviewThread[]> {
		return (await this.threads(pullNumber)).map((comments) => {
			const resolver = comments.find((comment) => comment.resolver)?.resolver;
			const id = String(comments[0]!.id);
			return {
				id,
				isResolved: !!resolver,
				resolvedBy: resolver ? this.name(resolver) : null,
				rootCommentId: id
			};
		});
	}

	async resolveReviewThreads(_pullNumber: number, rootCommentIds: string[]): Promise<number> {
		let resolved = 0;
		for (const id of rootCommentIds) {
			await this.api.request(
				'POST',
				`${this.path}/pulls/comments/${encodeURIComponent(id)}/resolve`
			);
			resolved++;
		}
		return resolved;
	}

	/** Issues the description closes with Gitea's keywords (`Fixes #12`), from this repository. */
	async getLinkedIssues(pullNumber: number): Promise<LinkedIssueRef[]> {
		const pr = await this.api.request<{ body?: string }>('GET', `${this.path}/pulls/${pullNumber}`);
		const numbers = [
			...new Set([...(pr.body ?? '').matchAll(CLOSING_REFERENCE)].map((match) => Number(match[1])))
		]
			.filter((number) => number !== pullNumber)
			.slice(0, MAX_LINKED_ISSUES);
		const issues: LinkedIssueRef[] = [];
		for (const number of numbers) {
			const issue = await this.api
				.request<{
					number: number;
					title: string;
					body?: string;
					pull_request?: unknown;
				}>('GET', `${this.path}/issues/${number}`)
				.catch(() => null);
			if (!issue || issue.pull_request) continue;
			issues.push({
				number: issue.number,
				title: issue.title,
				body: truncate(issue.body ?? '', MAX_ISSUE_BODY_CHARS)
			});
		}
		return issues;
	}

	/** The latest status of each context that failed, except the bot's own. */
	async getFailedChecks(headSha: string, ownAppId: string): Promise<FailedCheckRun[]> {
		const combined = await this.api.request<{ statuses?: Status[] | null }>(
			'GET',
			`${this.path}/commits/${encodeURIComponent(headSha)}/status`
		);
		return (combined.statuses ?? [])
			.filter(
				(status) => FAILED_STATES.has(status.status) && String(status.creator?.id) !== ownAppId
			)
			.slice(0, MAX_FAILED_CHECKS)
			.map((status) => ({
				name: status.context,
				conclusion: 'failure',
				output: [status.description, status.target_url].filter(Boolean).join('\n\n'),
				annotations: []
			}));
	}

	/**
	 * Posts the bot's commit status. Gitea shows the latest per context, so starting again on the
	 * same commit takes over the one the bot left pending. `externalId` names it apart from
	 * another project's.
	 */
	async startCheckRun(input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		externalId?: string;
		output?: { title: string; summary: string };
	}): Promise<string> {
		const run = {
			headSha: input.headSha,
			context: input.externalId ? `${input.name} (${input.externalId})` : input.name,
			...(input.detailsUrl ? { detailsUrl: input.detailsUrl } : {})
		};
		const id = `${run.headSha}:${run.context}`;
		this.checkRuns.set(id, run);
		await this.postStatus(run, 'pending', input.output?.title);
		return id;
	}

	async updateCheckRun(checkRunId: string, output: { title: string; summary: string }) {
		await this.postStatus(this.checkRun(checkRunId), 'pending', output.title);
	}

	async completeCheckRun(
		checkRunId: string,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void> {
		await this.postStatus(this.checkRun(checkRunId), states[input.conclusion], input.title);
	}

	private async postStatus(
		run: { headSha: string; context: string; detailsUrl?: string },
		state: string,
		description?: string
	): Promise<void> {
		await this.api.request('POST', `${this.path}/statuses/${encodeURIComponent(run.headSha)}`, {
			body: {
				state,
				context: run.context,
				...(description ? { description } : {}),
				...(run.detailsUrl ? { target_url: run.detailsUrl } : {})
			}
		});
	}

	private checkRun(id: string) {
		const run = this.checkRuns.get(id);
		if (!run) throw new Error(`check run ${id} was not started by this client`);
		return run;
	}

	private reviews(pullNumber: number): Promise<Review[]> {
		return this.api.list<Review>(`${this.path}/pulls/${pullNumber}/reviews`);
	}

	/**
	 * Every review comment, as threads: the comments on one line of one file, oldest first. A
	 * reply joins the review of the comment it answers, so the reviews' comments hold them all.
	 */
	private async threads(pullNumber: number): Promise<ReviewCommentBody[][]> {
		const reviews = await this.reviews(pullNumber);
		const comments = (
			await Promise.all(
				reviews
					.filter((review) => review.state !== 'PENDING')
					.map((review) =>
						this.api.request<ReviewCommentBody[]>(
							'GET',
							`${this.path}/pulls/${pullNumber}/reviews/${review.id}/comments`
						)
					)
			)
		)
			.flat()
			.sort((a, b) => a.id - b.id);
		const threads = new Map<string, ReviewCommentBody[]>();
		for (const comment of comments) {
			const key = `${comment.path}\0${comment.position ?? 0}\0${comment.original_position ?? 0}`;
			const thread = threads.get(key);
			if (thread) thread.push(comment);
			else threads.set(key, [comment]);
		}
		return [...threads.values()];
	}

	private issueComments(issueNumber: number): Promise<IssueComment[]> {
		return this.api.request<IssueComment[]>('GET', `${this.path}/issues/${issueNumber}/comments`);
	}

	/** The name the engine knows a user by: the login, and the bot `<slug>[bot]`, as on GitHub. */
	private name(user: User | null | undefined): string {
		if (!user) return 'unknown';
		return this.isOwn(user) ? `${this.app.slug}[bot]` : user.login;
	}

	private isOwn(user: User | null | undefined): boolean {
		return !!user && String(user.id) === this.app.id;
	}

	private commentUrl(issueNumber: number, comment: IssueComment): string {
		return (
			comment.html_url ||
			`${this.repository.html_url.replace(/\/+$/, '')}/pulls/${issueNumber}#issuecomment-${comment.id}`
		);
	}
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n… truncated` : trimmed;
}
