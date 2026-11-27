import { createHash } from 'node:crypto';
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
import { BitbucketApi, BitbucketError, type BitbucketApiConfig } from './api';

// The engine's client contract on Bitbucket Cloud. The token is the bot's: an OAuth or access
// token Appwrite holds for the repository, never one this client mints.
//
// Bitbucket threads hang off their first comment, as on GitHub, so comment ids key them. It has no
// review object: a review is its inline comments, a comment with the body, and the bot's approval
// or change request. It has no reactions either, so a comment is not acknowledged.
//
// The check run is a build status. Bitbucket keeps no author on one, so the bot's own are told
// apart by the key prefix it gives them.

export interface InstallationToken {
	token: string;
	expiresAt: Date;
	/** The bot account: its uuid or account id, and the nickname people mention it by. */
	app: { id: string; slug: string };
}

/** Hands out the bot's token for one repository: the project's `repositories` row. */
export interface InstallationTokens {
	get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken>;
}

/** Renew a token this long before it expires. */
const TOKEN_MARGIN_MS = 2 * 60_000;

/** Bitbucket's user name for an access or OAuth token over git. */
const GIT_USERNAME = 'x-token-auth';

/** Every build status key the bot writes starts with this. Keys are at most 40 characters. */
const STATUS_KEY_PREFIX = 'appwrite-hansi-';

/**
 * Marks a comment as a review the bot submitted, and its verdict, in a markdown comment that
 * renders as nothing. Bitbucket keeps one change request per account, so the mark is how the bot
 * finds the review a change request came from.
 */
const VERDICT_MARK = '[//]: # (appwrite-hansi-verdict:';

const MAX_FAILED_CHECKS = 5;
const WRITE_PERMISSIONS = new Set(['write', 'admin']);

export class InstallationBitbucketClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: BitbucketApiConfig = {}
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
		// The repository's `{uuid}` survives a rename; its slug is the fallback. Appwrite names a
		// repository by its full name, `workspace/slug`, which carries the workspace too.
		const id = repository.providerRepositoryId || repository.name;
		const [workspace, slug] = id.includes('/')
			? [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)]
			: [repository.owner, id];
		const path = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
		const github = new BitbucketClient(
			new BitbucketApi(token, this.config),
			path,
			token,
			current.app
		);
		const { webUrl } = await github.getRepository();
		return { github, app: current.app, filesUrl: `${webUrl}/src` };
	}
}

interface User {
	uuid?: string;
	account_id?: string;
	nickname?: string;
	display_name?: string;
	type?: string;
}

interface Comment {
	id: number;
	content: { raw: string };
	user?: User;
	inline?: { path: string; to?: number | null; from?: number | null };
	parent?: { id: number };
	deleted?: boolean;
	resolution?: { user?: User } | null;
	links?: { html?: { href?: string } };
}

interface Side {
	branch: { name: string };
	commit: { hash: string };
	repository?: { full_name?: string; uuid?: string };
}

interface PullRequestBody {
	id: number;
	title: string;
	description?: string;
	author?: User;
	state: string;
	draft?: boolean;
	source: Side;
	destination: Side;
	participants?: { user?: User; state?: string | null }[];
	links?: { html?: { href?: string } };
}

interface Status {
	key: string;
	state: string;
	name?: string;
	description?: string;
	url?: string;
}

const states: Record<CheckConclusion, string> = {
	success: 'SUCCESSFUL',
	neutral: 'SUCCESSFUL',
	failure: 'FAILED',
	skipped: 'STOPPED',
	cancelled: 'STOPPED'
};

export class BitbucketClient implements GitHubClient {
	/** Bitbucket names people by nickname; permissions go by uuid. Uuids seen so far, by name. */
	private readonly userIds = new Map<string, string>();
	/** The threads each review opened, as the engine asks for them after the review. */
	private readonly reviews = new Map<string, PostedReviewComment[]>();
	/** Statuses are posted whole, so each update repeats what started the run. */
	private readonly checkRuns = new Map<
		string,
		{ headSha: string; key: string; name: string; url: string }
	>();
	/** The pull request of each comment this client read or wrote, to edit it by. */
	private readonly commentPulls = new Map<string, number>();
	private repository?: Promise<{ webUrl: string; cloneUrl: string; fullName: string }>;

	constructor(
		private readonly api: BitbucketApi,
		private readonly path: string,
		private readonly token: () => Promise<string>,
		private readonly app: GitHubApp
	) {}

	async getInstallationToken(): Promise<GitCredential> {
		return { username: GIT_USERNAME, token: await this.token() };
	}

	async getPullRequest(pullNumber: number): Promise<PullRequest> {
		const [pr, repository] = await Promise.all([
			this.pullRequest(pullNumber),
			this.getRepository()
		]);
		const source = pr.source.repository?.full_name;
		if (source && source.toLowerCase() !== repository.fullName.toLowerCase()) {
			// Bitbucket keeps no ref for a fork's head in the target repository.
			throw new Error(
				`pull request ${pullNumber} is from the fork ${source}, which is not supported`
			);
		}
		// Bitbucket gives a pull request's commits abbreviated; git and positions need them whole.
		const [baseSha, headSha] = await Promise.all([
			this.fullSha(pr.destination.commit.hash),
			this.fullSha(pr.source.commit.hash)
		]);
		return {
			number: pr.id,
			title: pr.title,
			body: pr.description ?? '',
			author: this.name(pr.author),
			// Bitbucket has no author association: trust comes from the repository permission.
			authorAssociation: '',
			botOnOwnBranch: false,
			draft: pr.draft ?? false,
			state: pr.state === 'OPEN' ? 'open' : 'closed',
			merged: pr.state === 'MERGED',
			baseRef: pr.destination.branch.name,
			baseSha,
			headSha,
			headRef: `refs/heads/${pr.source.branch.name}`,
			cloneUrl: repository.cloneUrl
		};
	}

	isTrustedAuthor(pr: { author: string }) {
		return this.hasWriteAccess(pr.author);
	}

	/** Bitbucket shows a user's permission to repository admins only; anything else is a no. */
	async hasWriteAccess(username: string): Promise<boolean> {
		const id = this.userIds.get(username);
		if (!id) return false;
		try {
			const { permission } = await this.api.request<{ permission: string }>(
				'GET',
				`${this.path}/permissions-config/users/${encodeURIComponent(id)}`
			);
			return WRITE_PERMISSIONS.has(permission);
		} catch {
			return false;
		}
	}

	async getFileContent(path: string, gitRef: string): Promise<string | null> {
		try {
			const file = path.split('/').map(encodeURIComponent).join('/');
			return await this.api.raw(`${this.path}/src/${encodeURIComponent(gitRef)}/${file}`);
		} catch (error) {
			if (error instanceof BitbucketError && error.status === 404) return null;
			throw error;
		}
	}

	/**
	 * Posts each inline comment, then the body and the verdict. Bitbucket takes the comments one
	 * at a time, so when it refuses one, those already posted are deleted again and the refusal is
	 * passed on: the engine then puts every finding in the body, as it does when GitHub refuses.
	 */
	async createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: string }> {
		const comments = `${this.pullPath(input.pullNumber)}/comments`;
		const posted: PostedReviewComment[] = [];
		try {
			for (const comment of input.comments) {
				const created = await this.api.request<Comment>('POST', comments, {
					body: { content: { raw: comment.body }, inline: { path: comment.path, to: comment.line } }
				});
				posted.push({
					id: String(created.id),
					path: comment.path,
					line: comment.line,
					body: comment.body
				});
			}
		} catch (error) {
			if (error instanceof BitbucketError && error.unprocessable) {
				for (const comment of posted) {
					await this.api.request('DELETE', `${comments}/${comment.id}`).catch(() => {});
				}
			}
			throw error;
		}
		const review = await this.api.request<Comment>('POST', comments, {
			body: { content: { raw: `${input.body}\n\n${VERDICT_MARK}${input.event})` } }
		});
		if (input.event === 'APPROVE') {
			await this.api.request('POST', `${this.pullPath(input.pullNumber)}/approve`);
		} else if (input.event === 'REQUEST_CHANGES') {
			await this.api.request('POST', `${this.pullPath(input.pullNumber)}/request-changes`);
		}
		const id = String(review.id);
		this.reviews.set(id, posted);
		return { id };
	}

	async createFileComment(input: {
		pullNumber: number;
		path: string;
		body: string;
	}): Promise<string> {
		const comment = await this.api.request<Comment>(
			'POST',
			`${this.pullPath(input.pullNumber)}/comments`,
			{ body: { content: { raw: input.body }, inline: { path: input.path } } }
		);
		return String(comment.id);
	}

	async listPullRequestPatches(pullNumber: number): Promise<{ path: string; patch?: string }[]> {
		return splitPatches(await this.api.raw(`${this.pullPath(pullNumber)}/diff`));
	}

	async listReviewComments(_pullNumber: number, reviewId: string): Promise<PostedReviewComment[]> {
		return this.reviews.get(reviewId) ?? [];
	}

	/**
	 * Withdraws the bot's change request when the last review that requested changes is one
	 * `only` accepts. Bitbucket keeps a single change request per account, so it is one or none.
	 */
	async dismissChangeRequests(
		pullNumber: number,
		input: { botLogin: string; message: string; only?: (body: string) => boolean }
	): Promise<number> {
		const pr = await this.pullRequest(pullNumber);
		const requested = pr.participants?.some(
			(p) => this.isOwn(p.user) && p.state === 'changes_requested'
		);
		if (!requested) return 0;
		const last = (await this.comments(pullNumber))
			.filter(
				(c) =>
					!c.inline &&
					this.isOwn(c.user) &&
					c.content.raw.includes(`${VERDICT_MARK}REQUEST_CHANGES)`)
			)
			.at(-1);
		if (!last || (input.only && !input.only(last.content.raw))) return 0;
		// Bitbucket's change request carries no message to dismiss it with.
		await this.api.request('DELETE', `${this.pullPath(pullNumber)}/request-changes`);
		return 1;
	}

	async createIssueComment(issueNumber: number, body: string): Promise<void> {
		await this.api.request('POST', `${this.pullPath(issueNumber)}/comments`, {
			body: { content: { raw: body } }
		});
	}

	/** Comments are edited through their pull request, which the id alone lacks. */
	async updateIssueComment(commentId: string, body: string): Promise<void> {
		const pullNumber = this.commentPulls.get(commentId);
		if (pullNumber === undefined)
			throw new Error(`comment ${commentId} was not read by this client`);
		await this.api.request('PUT', `${this.pullPath(pullNumber)}/comments/${commentId}`, {
			body: { content: { raw: body } }
		});
	}

	async getMarkedComment(
		issueNumber: number,
		marker: string
	): Promise<{ id: string; url: string; body: string } | null> {
		const existing = (await this.conversation(issueNumber)).find(
			(c) => this.isOwn(c.user) && c.content.raw.includes(marker)
		);
		if (!existing) return null;
		const id = String(existing.id);
		this.commentPulls.set(id, issueNumber);
		return { id, url: await this.commentUrl(issueNumber, existing), body: existing.content.raw };
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
			`${this.pullPath(issueNumber)}/comments`,
			{ body: { content: { raw: body } } }
		);
		const id = String(created.id);
		this.commentPulls.set(id, issueNumber);
		return { id, url: await this.commentUrl(issueNumber, created) };
	}

	/** Bitbucket has no reactions to acknowledge a comment with. */
	async acknowledgeComment(): Promise<void> {}

	async finishAcknowledgement(): Promise<void> {}

	async getReviewThread(pullNumber: number, rootCommentId: string): Promise<ThreadComment[]> {
		const comments = await this.comments(pullNumber);
		const inThread = new Set([rootCommentId]);
		const thread: Comment[] = [];
		// Replies come after what they reply to, so one pass collects the whole tree.
		for (const comment of comments) {
			const id = String(comment.id);
			if (id === rootCommentId || (comment.parent && inThread.has(String(comment.parent.id)))) {
				inThread.add(id);
				thread.push(comment);
			}
		}
		return thread.map((comment) => this.threadComment(comment));
	}

	async getRecentIssueComments(
		issueNumber: number,
		limit = 20,
		untilId?: string
	): Promise<ThreadComment[]> {
		const comments = await this.conversation(issueNumber);
		const until = untilId === undefined ? -1 : comments.findIndex((c) => String(c.id) === untilId);
		const upTo = until === -1 ? comments : comments.slice(0, until + 1);
		return upTo.slice(-limit).map((comment) => this.threadComment(comment));
	}

	async replyToReviewComment(pullNumber: number, commentId: string, body: string): Promise<void> {
		await this.api.request('POST', `${this.pullPath(pullNumber)}/comments`, {
			body: { content: { raw: body }, parent: { id: Number(commentId) } }
		});
	}

	async listReviewThreads(pullNumber: number): Promise<ReviewThread[]> {
		return (await this.comments(pullNumber))
			.filter((comment) => comment.inline && !comment.parent)
			.map((comment) => ({
				id: String(comment.id),
				isResolved: !!comment.resolution,
				resolvedBy: comment.resolution?.user ? this.name(comment.resolution.user) : null,
				rootCommentId: String(comment.id)
			}));
	}

	async resolveReviewThreads(pullNumber: number, rootCommentIds: string[]): Promise<number> {
		let resolved = 0;
		for (const id of rootCommentIds) {
			try {
				await this.api.request('POST', `${this.pullPath(pullNumber)}/comments/${id}/resolve`);
			} catch (error) {
				// Already resolved.
				if (!(error instanceof BitbucketError && error.status === 409)) throw error;
			}
			resolved++;
		}
		return resolved;
	}

	/** Bitbucket's issues are mostly elsewhere (Jira), and nothing links one to a pull request. */
	async getLinkedIssues(): Promise<LinkedIssueRef[]> {
		return [];
	}

	async getFailedChecks(headSha: string): Promise<FailedCheckRun[]> {
		const statuses = await this.api.list<Status>(
			`${this.path}/commit/${encodeURIComponent(headSha)}/statuses`
		);
		return statuses
			.filter(
				(status) =>
					(status.state === 'FAILED' || status.state === 'STOPPED') &&
					!status.key.startsWith(STATUS_KEY_PREFIX)
			)
			.slice(0, MAX_FAILED_CHECKS)
			.map((status) => ({
				name: status.name || status.key,
				conclusion: status.state === 'FAILED' ? 'failure' : 'cancelled',
				output: [status.description, status.url].filter(Boolean).join('\n\n'),
				annotations: []
			}));
	}

	/**
	 * Posts the bot's build status. Bitbucket keeps one per key and commit, so starting again on
	 * the same commit takes over the one the bot left in progress. `externalId` keys it apart from
	 * another project's.
	 */
	async startCheckRun(input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		externalId?: string;
		output?: { title: string; summary: string };
	}): Promise<string> {
		const scope = `${input.name}\n${input.externalId ?? ''}`;
		const run = {
			headSha: input.headSha,
			key: `${STATUS_KEY_PREFIX}${createHash('sha256').update(scope).digest('hex').slice(0, 20)}`,
			name: input.externalId ? `${input.name} (${input.externalId})` : input.name,
			// Bitbucket requires a link on every status.
			url: input.detailsUrl ?? (await this.getRepository()).webUrl
		};
		const id = `${run.headSha}:${run.key}`;
		this.checkRuns.set(id, run);
		await this.postStatus(run, 'INPROGRESS', input.output?.title);
		return id;
	}

	async updateCheckRun(checkRunId: string, output: { title: string; summary: string }) {
		await this.postStatus(this.checkRun(checkRunId), 'INPROGRESS', output.title);
	}

	async completeCheckRun(
		checkRunId: string,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void> {
		await this.postStatus(this.checkRun(checkRunId), states[input.conclusion], input.title);
	}

	/** The repository's web and clone URLs and full name, read once. */
	getRepository() {
		this.repository ??= this.api
			.request<{
				full_name: string;
				links: { html: { href: string }; clone?: { name: string; href: string }[] };
			}>('GET', this.path)
			.then((repository) => {
				const webUrl = repository.links.html.href.replace(/\/+$/, '');
				const https = repository.links.clone?.find((link) => link.name === 'https')?.href;
				return {
					webUrl,
					// The clone link names a user; git signs in with the token's own.
					cloneUrl: https ? withoutUser(https) : `${webUrl}.git`,
					fullName: repository.full_name
				};
			});
		return this.repository;
	}

	private async postStatus(
		run: { headSha: string; key: string; name: string; url: string },
		state: string,
		description?: string
	): Promise<void> {
		await this.api.request(
			'POST',
			`${this.path}/commit/${encodeURIComponent(run.headSha)}/statuses/build`,
			{
				body: {
					key: run.key,
					state,
					name: run.name,
					url: run.url,
					...(description ? { description } : {})
				}
			}
		);
	}

	private checkRun(id: string) {
		const run = this.checkRuns.get(id);
		if (!run) throw new Error(`check run ${id} was not started by this client`);
		return run;
	}

	private pullRequest(pullNumber: number) {
		return this.api.request<PullRequestBody>('GET', this.pullPath(pullNumber));
	}

	private pullPath(pullNumber: number): string {
		return `${this.path}/pullrequests/${pullNumber}`;
	}

	private async fullSha(hash: string): Promise<string> {
		if (hash.length >= 40) return hash;
		const commit = await this.api.request<{ hash: string }>(
			'GET',
			`${this.path}/commit/${encodeURIComponent(hash)}`
		);
		return commit.hash;
	}

	/** Every comment that is still there, oldest first. */
	private async comments(pullNumber: number): Promise<Comment[]> {
		const comments = await this.api.list<Comment>(`${this.pullPath(pullNumber)}/comments`, {
			sort: 'created_on'
		});
		return comments.filter((comment) => !comment.deleted);
	}

	/** Comments in the conversation, oldest first: none on the diff. */
	private async conversation(pullNumber: number): Promise<Comment[]> {
		return (await this.comments(pullNumber)).filter((comment) => !comment.inline);
	}

	private threadComment(comment: Comment): ThreadComment {
		return {
			id: String(comment.id),
			author: this.name(comment.user),
			body: comment.content.raw,
			isBot: this.isOwn(comment.user) || comment.user?.type === 'app_user',
			...(comment.inline
				? { path: comment.inline.path, line: comment.inline.to ?? comment.inline.from ?? null }
				: {})
		};
	}

	/** The name the engine knows a user by: the nickname, and the bot `<slug>[bot]`, as on GitHub. */
	private name(user: User | undefined): string {
		if (!user) return 'unknown';
		if (this.isOwn(user)) return `${this.app.slug}[bot]`;
		const name = user.nickname || user.display_name || user.account_id || user.uuid || 'unknown';
		const id = user.uuid || user.account_id;
		if (id) this.userIds.set(name, id);
		return name;
	}

	private isOwn(user: User | undefined): boolean {
		return !!user && (user.uuid === this.app.id || user.account_id === this.app.id);
	}

	private async commentUrl(pullNumber: number, comment: Comment): Promise<string> {
		const href = comment.links?.html?.href;
		if (href) return href;
		const { webUrl } = await this.getRepository();
		return `${webUrl}/pull-requests/${pullNumber}#comment-${comment.id}`;
	}
}

function withoutUser(url: string): string {
	const parsed = new URL(url);
	parsed.username = '';
	parsed.password = '';
	return parsed.toString();
}
