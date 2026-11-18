import type {
	CheckConclusion,
	FailedCheckRun,
	GitHubApp,
	GitHubClient,
	GitHubClientFactory,
	GitHubConnection,
	LinkedIssueRef,
	PostedReviewComment,
	PullRequest,
	ReviewComment,
	ReviewEvent,
	ReviewThread,
	ThreadComment
} from '@hansi/engine';
import { OriginApi, OriginError, type OriginApiConfig } from './api';

// The engine's client contract on Origin, Cursor's git host. Appwrite owns the Origin App and
// mints its installation tokens; this client only holds short-lived ones.
//
// Origin threads have ids of their own (`cth_…`), so where the engine keys a review thread by its
// root comment, this client uses the thread id: findings, replies and resolutions all go by it.
// A conversation comment is a comment in a general-discussion thread, one with no path.

export interface InstallationToken {
	token: string;
	expiresAt: Date;
	/** The Origin App the token is for: its `app_…` id and the handle users mention it by. */
	app: { id: string; slug: string };
}

/** Mints installation tokens scoped to one repository: the project's `repositories` row. */
export interface InstallationTokens {
	get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken>;
}

/** Origin's web host, for a repository Origin gives no web URL for. */
const ORIGIN_WEB_URL = 'https://cursor.com/codebase';

/** Tokens live at most 15 minutes; renew them this long before they expire. */
const TOKEN_MARGIN_MS = 2 * 60_000;

/** At most this many comments go in one review; the rest are posted on their own after it. */
const MAX_REVIEW_COMMENTS = 50;

const MAX_FAILED_CHECKS = 5;
const MAX_CHECK_OUTPUT_CHARS = 4_000;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

const WRITE_PERMISSIONS = new Set(['write', 'admin']);

export class InstallationOriginClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: OriginApiConfig = {}
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
		// The id form of a repository path survives a rename; owner and name are the fallback.
		const path = repository.providerRepositoryId
			? `/repos/_/${encodeURIComponent(repository.providerRepositoryId)}`
			: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
		const api = new OriginApi(token, this.config);
		const github = new OriginClient(api, path, token, current.app);
		const { webUrl } = await github.getRepository();
		return {
			github,
			app: current.app,
			filesUrl: `${webUrl || `${ORIGIN_WEB_URL}/${repository.owner}/${repository.name}`}/blob`
		};
	}
}

interface Actor {
	user?: { id: string; handle?: string; displayName?: string };
	app?: { id: string; displayName?: string };
	serviceAccount?: { id: string; displayName?: string };
}

interface Thread {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	resolvedAt?: string;
}

interface Comment {
	id: string;
	thread: Thread;
	body: string;
	author?: Actor;
	createdAt: string;
}

interface Review {
	id: string;
	author?: Actor;
	verdict: string;
	body: string;
	dismissal?: unknown;
}

interface CheckRun {
	id: string;
	name: string;
	status: string;
	conclusion?: string;
	actor?: Actor;
	output?: { title?: string; summary?: string; text?: string };
}

const verdicts: Record<ReviewEvent, string> = {
	APPROVE: 'approve',
	REQUEST_CHANGES: 'request_changes',
	COMMENT: 'comment'
};

export class OriginClient implements GitHubClient {
	/** Origin names people by id; the engine by a login. Ids seen so far, by the name given out. */
	private readonly userIds = new Map<string, string>();
	/** When each review this client created was submitted, to find the threads it opened. */
	private readonly reviewsSince = new Map<string, string>();
	/** Check runs are upserted whole, so each update repeats what started the run. */
	private readonly checkRuns = new Map<
		string,
		{ headSha: string; name: string; key: string; externalId: string; detailsUrl?: string }
	>();
	private lastUpdate = 0;
	private repository?: Promise<{ cloneUrl: string; webUrl: string }>;

	constructor(
		private readonly api: OriginApi,
		private readonly path: string,
		private readonly token: () => Promise<string>,
		private readonly app: GitHubApp
	) {}

	getInstallationToken() {
		return this.token();
	}

	async getPullRequest(pullNumber: number): Promise<PullRequest> {
		const [pr, repository] = await Promise.all([
			this.api.request<{
				number: string;
				title: string;
				body: string;
				author?: Actor;
				draft: boolean;
				state: string;
				merged: boolean;
				head: { ref: string; sha: string };
				base: { ref: string; sha: string };
			}>('GET', `${this.path}/pulls/${pullNumber}`),
			this.getRepository()
		]);
		return {
			number: Number(pr.number),
			title: pr.title,
			body: pr.body,
			author: this.name(pr.author),
			// Origin has no author association: trust comes from the repository permission.
			authorAssociation: '',
			// Origin has no forks, but a bot's pull request is still checked like anyone else's.
			botOnOwnBranch: false,
			draft: pr.draft,
			state: pr.state,
			merged: pr.merged,
			baseRef: branch(pr.base.ref),
			baseSha: pr.base.sha,
			headSha: pr.head.sha,
			headRef: pr.head.ref.startsWith('refs/') ? pr.head.ref : `refs/heads/${pr.head.ref}`,
			cloneUrl: repository.cloneUrl
		};
	}

	isTrustedAuthor(pr: { author: string }) {
		return this.hasWriteAccess(pr.author);
	}

	async hasWriteAccess(username: string): Promise<boolean> {
		const id = this.userIds.get(username);
		if (!id) return false;
		try {
			const { permission } = await this.api.request<{ permission: string }>(
				'GET',
				`${this.path}/collaborators/${encodeURIComponent(id)}/permission`
			);
			return WRITE_PERMISSIONS.has(permission);
		} catch {
			return false;
		}
	}

	async getFileContent(path: string, gitRef: string): Promise<string | null> {
		try {
			const file = await this.api.request<{ type: string; content?: string }>(
				'GET',
				`${this.path}/contents`,
				{ path, ref: gitRef }
			);
			if (file.type !== 'file' || file.content === undefined) return null;
			return Buffer.from(file.content, 'base64').toString('utf8');
		} catch (error) {
			if (error instanceof OriginError && error.status === 404) return null;
			throw error;
		}
	}

	async createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: string }> {
		const since = new Date(Date.now() - 1000).toISOString();
		const inReview = input.comments.slice(0, MAX_REVIEW_COMMENTS);
		const review = await this.api.request<{ id: string }>(
			'POST',
			`${this.path}/pulls/${input.pullNumber}/reviews`,
			{
				verdict: verdicts[input.event],
				body: input.body,
				comments: inReview.map((comment) => ({ body: comment.body, inline: anchor(comment) }))
			}
		);
		this.reviewsSince.set(review.id, since);
		// Comments past Origin's limit open their threads right after the review, outside it.
		for (const comment of input.comments.slice(MAX_REVIEW_COMMENTS)) {
			await this.api.request('POST', `${this.path}/pulls/${input.pullNumber}/comments`, {
				body: comment.body,
				inline: anchor(comment)
			});
		}
		return { id: review.id };
	}

	async createFileComment(input: {
		pullNumber: number;
		path: string;
		body: string;
	}): Promise<string> {
		const comment = await this.api.request<Comment>(
			'POST',
			`${this.path}/pulls/${input.pullNumber}/comments`,
			{ body: input.body, file: { path: input.path } }
		);
		return comment.thread.id;
	}

	async listPullRequestPatches(pullNumber: number): Promise<{ path: string; patch?: string }[]> {
		const files = await this.api.list<{ filename: string; patch?: string }>(
			`${this.path}/pulls/${pullNumber}/files`,
			'files'
		);
		return files.map((file) => ({
			path: file.filename,
			...(file.patch ? { patch: file.patch } : {})
		}));
	}

	/**
	 * The threads the app opened with a review. Origin's comments do not name their review, so
	 * these are the app's threads opened on the pull request since the review was submitted.
	 */
	async listReviewComments(pullNumber: number, reviewId: string): Promise<PostedReviewComment[]> {
		const since = this.reviewsSince.get(reviewId);
		const comments = await this.comments(pullNumber, since ? { since } : {});
		return roots(comments)
			.filter((comment) => comment.thread.path && this.isOwn(comment.author))
			.map((comment) => ({
				id: comment.thread.id,
				path: comment.thread.path,
				line: comment.thread.endLine || comment.thread.startLine || null,
				body: comment.body
			}));
	}

	async dismissChangeRequests(
		pullNumber: number,
		input: { botLogin: string; message: string; only?: (body: string) => boolean }
	): Promise<number> {
		const reviews = await this.api.list<Review>(
			`${this.path}/pulls/${pullNumber}/reviews`,
			'reviews'
		);
		const open = reviews.filter(
			(review) =>
				review.verdict === 'request_changes' &&
				!review.dismissal &&
				this.isOwn(review.author) &&
				(!input.only || input.only(review.body))
		);
		for (const review of open) {
			await this.api.request(
				'PUT',
				`${this.path}/pulls/${pullNumber}/reviews/${encodeURIComponent(review.id)}/dismissals`,
				{ message: input.message }
			);
		}
		return open.length;
	}

	async createIssueComment(issueNumber: number, body: string): Promise<void> {
		await this.api.request('POST', `${this.path}/pulls/${issueNumber}/comments`, { body });
	}

	async updateIssueComment(commentId: string, body: string): Promise<void> {
		await this.api.request(
			'PATCH',
			`${this.path}/pulls/comments/${encodeURIComponent(commentId)}`,
			{
				body
			}
		);
	}

	async getMarkedComment(
		issueNumber: number,
		marker: string
	): Promise<{ id: string; url: string; body: string } | null> {
		const comments = await this.comments(issueNumber);
		const existing = comments.find(
			(comment) =>
				!comment.thread.path && this.isOwn(comment.author) && comment.body.includes(marker)
		);
		if (!existing) return null;
		return { id: existing.id, url: await this.pullUrl(issueNumber), body: existing.body };
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
		const created = await this.api.request<Comment>(
			'POST',
			`${this.path}/pulls/${issueNumber}/comments`,
			{ body }
		);
		return { id: created.id, url: await this.pullUrl(issueNumber) };
	}

	async acknowledgeComment(_pullNumber: number, comment: { id: string }): Promise<void> {
		await this.api.request(
			'POST',
			`${this.path}/pulls/comments/${encodeURIComponent(comment.id)}/reactions`,
			{ emoji: '👀' }
		);
	}

	async getReviewThread(pullNumber: number, rootCommentId: string): Promise<ThreadComment[]> {
		const comments = await this.comments(pullNumber, { threadIds: [rootCommentId] });
		return comments.map((comment) => this.threadComment(comment));
	}

	async getRecentIssueComments(
		issueNumber: number,
		limit = 20,
		untilId?: string
	): Promise<ThreadComment[]> {
		const general = (await this.comments(issueNumber)).filter((comment) => !comment.thread.path);
		const until = untilId === undefined ? -1 : general.findIndex((c) => c.id === untilId);
		const upTo = until === -1 ? general : general.slice(0, until + 1);
		return upTo.slice(-limit).map((comment) => this.threadComment(comment));
	}

	async replyToReviewComment(pullNumber: number, commentId: string, body: string): Promise<void> {
		await this.api.request('POST', `${this.path}/pulls/${pullNumber}/comments`, {
			body,
			threadId: commentId
		});
	}

	async listReviewThreads(pullNumber: number): Promise<ReviewThread[]> {
		return roots(await this.comments(pullNumber)).map((comment) => ({
			id: comment.thread.id,
			isResolved: !!comment.thread.resolvedAt,
			// Origin does not say who resolved a thread.
			resolvedBy: null,
			rootCommentId: comment.thread.id
		}));
	}

	async resolveReviewThreads(_pullNumber: number, rootCommentIds: string[]): Promise<number> {
		let resolved = 0;
		for (const threadId of rootCommentIds) {
			await this.api.request(
				'PATCH',
				`${this.path}/pulls/threads/${encodeURIComponent(threadId)}`,
				{ resolved: true }
			);
			resolved++;
		}
		return resolved;
	}

	/** Origin has no issues to link. */
	async getLinkedIssues(): Promise<LinkedIssueRef[]> {
		return [];
	}

	async getFailedChecks(headSha: string, ownAppId: string): Promise<FailedCheckRun[]> {
		const runs = await this.api.list<CheckRun>(
			`${this.path}/commits/${encodeURIComponent(headSha)}/check-runs`,
			'checkRuns'
		);
		return runs
			.filter(
				(run) =>
					run.status === 'completed' &&
					FAILED_CONCLUSIONS.has(run.conclusion ?? '') &&
					run.actor?.app?.id !== ownAppId
			)
			.slice(0, MAX_FAILED_CHECKS)
			.map((run) => ({
				name: run.name,
				conclusion: run.conclusion ?? 'failure',
				output: truncate(
					[run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join('\n\n'),
					MAX_CHECK_OUTPUT_CHARS
				),
				annotations: []
			}));
	}

	/**
	 * Origin upserts a run by its key, so starting one again on the same commit takes over a run
	 * the app left in progress. `externalId` keys the run apart from another owner's.
	 */
	async startCheckRun(input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		externalId?: string;
		output?: { title: string; summary: string };
	}): Promise<string> {
		const base = slug(input.name);
		const key = input.externalId ? `${base}-${slug(input.externalId)}` : base;
		const run = {
			headSha: input.headSha,
			name: input.name,
			key,
			externalId: input.externalId ?? key,
			...(input.detailsUrl ? { detailsUrl: input.detailsUrl } : {})
		};
		const id = await this.postCheckRun(run, {
			status: 'in_progress',
			startedAt: new Date().toISOString(),
			...(input.output ? { output: input.output } : {})
		});
		this.checkRuns.set(id, run);
		return id;
	}

	async updateCheckRun(checkRunId: string, output: { title: string; summary: string }) {
		await this.postCheckRun(this.checkRun(checkRunId), { status: 'in_progress', output });
	}

	async completeCheckRun(
		checkRunId: string,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void> {
		await this.postCheckRun(this.checkRun(checkRunId), {
			status: 'completed',
			conclusion: input.conclusion,
			completedAt: new Date().toISOString(),
			output: { title: input.title, summary: input.summary }
		});
	}

	private async postCheckRun(
		run: { headSha: string; name: string; key: string; externalId: string; detailsUrl?: string },
		fields: Record<string, unknown>
	): Promise<string> {
		// Origin orders writes to a run by this time; two in the same millisecond would tie.
		this.lastUpdate = Math.max(Date.now(), this.lastUpdate + 1);
		const { checkRun } = await this.api.request<{ checkRun: { id: string } }>(
			'POST',
			`${this.path}/check-runs`,
			{
				headSha: run.headSha,
				checkSuite: { key: run.key, name: run.name, externalId: run.externalId },
				checkRun: {
					key: run.key,
					name: run.name,
					externalId: run.externalId,
					externalUpdatedAt: new Date(this.lastUpdate).toISOString(),
					...(run.detailsUrl ? { detailsUrl: run.detailsUrl } : {}),
					...fields
				}
			}
		);
		return checkRun.id;
	}

	private checkRun(id: string) {
		const run = this.checkRuns.get(id);
		if (!run) throw new Error(`check run ${id} was not started by this client`);
		return run;
	}

	private comments(pullNumber: number, query: Record<string, unknown> = {}): Promise<Comment[]> {
		return this.api.list<Comment>(`${this.path}/pulls/${pullNumber}/comments`, 'comments', query);
	}

	private threadComment(comment: Comment): ThreadComment {
		return {
			id: comment.id,
			author: this.name(comment.author),
			body: comment.body,
			isBot: !comment.author?.user,
			...(comment.thread.path
				? {
						path: comment.thread.path,
						line: comment.thread.endLine || comment.thread.startLine || null
					}
				: {})
		};
	}

	/**
	 * The name the engine knows an actor by. A person is their handle, or their id without one; an
	 * app or service account is `<name>[bot]`, and this app `<slug>[bot]`, as on GitHub.
	 */
	private name(actor: Actor | undefined): string {
		if (actor?.user) {
			const name = actor.user.handle || actor.user.id;
			this.userIds.set(name, actor.user.id);
			return name;
		}
		if (actor?.app) {
			return `${this.isOwn(actor) ? this.app.slug : actor.app.displayName || actor.app.id}[bot]`;
		}
		if (actor?.serviceAccount) {
			return `${actor.serviceAccount.displayName || actor.serviceAccount.id}[bot]`;
		}
		return 'unknown';
	}

	private isOwn(actor: Actor | undefined): boolean {
		return actor?.app?.id === this.app.id;
	}

	/** The repository's clone and web URLs, read once. */
	getRepository() {
		this.repository ??= this.api.request<{ cloneUrl: string; webUrl: string }>('GET', this.path);
		return this.repository;
	}

	private async pullUrl(pullNumber: number): Promise<string> {
		const { webUrl } = await this.getRepository();
		return `${webUrl}/pull/${pullNumber}`;
	}
}

/** The first comment of each thread, in thread order. */
function roots(comments: Comment[]): Comment[] {
	const seen = new Set<string>();
	return comments.filter((comment) => {
		if (seen.has(comment.thread.id)) return false;
		seen.add(comment.thread.id);
		return true;
	});
}

function anchor(comment: ReviewComment) {
	const start =
		comment.startLine && comment.startLine < comment.line ? comment.startLine : comment.line;
	return {
		path: comment.path,
		side: 'right',
		startLine: start,
		...(start < comment.line ? { endLine: comment.line } : {})
	};
}

function branch(ref: string): string {
	return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n… truncated` : trimmed;
}
