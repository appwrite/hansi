import type {
	CheckConclusion,
	FailedCheckRun,
	GitCredential,
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
import { GitLabApi, GitLabError, type GitLabApiConfig } from './api';

// The engine's client contract on GitLab, for a merge request. The token is the bot's: an OAuth
// or project access token Appwrite holds for the repository, never one this client mints.
//
// GitLab threads are discussions with ids of their own, so where the engine keys a review thread
// by its root comment, this client uses the discussion id: findings, replies and resolutions all
// go by it. A conversation comment is a note outside any diff discussion. GitLab has no review
// object: a review is its inline discussions, a note with the body, and an approval.
//
// The check run is a commit status. GitLab's own `Request changes` has no stable API yet, so a
// review that requests changes withdraws the bot's approval instead, and there is nothing left to
// dismiss afterwards.

export interface InstallationToken {
	token: string;
	expiresAt: Date;
	/** The bot account: its user id, and the username people mention it by. */
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

/** GitLab's user name for a token over git: works for OAuth, project and personal tokens. */
const GIT_USERNAME = 'oauth2';

const MAX_LINKED_ISSUES = 10;
const MAX_ISSUE_BODY_CHARS = 4_000;
const MAX_FAILED_CHECKS = 5;
/** GitLab cuts a status description at 255 characters. */
const MAX_DESCRIPTION_CHARS = 255;

/** Developer and above can push. */
const DEVELOPER_ACCESS = 30;

export class InstallationGitLabClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: GitLabApiConfig = {}
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
		// The numeric project id survives a rename or a transfer; the path is the fallback.
		const project = encodeURIComponent(
			repository.providerRepositoryId || `${repository.owner}/${repository.name}`
		);
		const github = new GitLabClient(
			new GitLabApi(token, { ...this.config, apiUrl: current.endpoint || this.config.apiUrl }),
			`/projects/${project}`,
			token,
			current.app
		);
		const { webUrl } = await github.getProject();
		return { github, app: current.app, filesUrl: `${webUrl}/-/blob` };
	}
}

interface User {
	id: number;
	username: string;
	bot?: boolean;
}

interface Position {
	new_path?: string;
	old_path?: string;
	new_line?: number | null;
	old_line?: number | null;
}

interface Note {
	id: number;
	body: string;
	author: User;
	system: boolean;
	type?: string | null;
	position?: Position | null;
	resolvable?: boolean;
	resolved?: boolean;
	resolved_by?: User | null;
}

interface Discussion {
	id: string;
	notes: Note[];
}

interface MergeRequest {
	iid: number;
	title: string;
	description: string | null;
	author: User;
	draft: boolean;
	state: string;
	target_branch: string;
	sha: string;
	diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null;
	web_url: string;
}

interface FileDiff {
	old_path: string;
	new_path: string;
	diff: string;
}

interface Version {
	id: number;
	head_commit_sha: string;
	base_commit_sha: string;
	start_commit_sha: string;
}

interface Status {
	name: string;
	status: string;
	description?: string | null;
	target_url?: string | null;
	allow_failure?: boolean;
	author?: User;
}

/** The diff version a review is anchored to: its commits and its files. */
interface Anchor {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	files: FileDiff[];
}

const states: Record<CheckConclusion, string> = {
	success: 'success',
	neutral: 'success',
	failure: 'failed',
	skipped: 'skipped',
	cancelled: 'canceled'
};

export class GitLabClient implements GitHubClient {
	/** GitLab names people by username; write access goes by id. Ids seen so far, by username. */
	private readonly userIds = new Map<string, number>();
	/** The threads each review opened, as the engine asks for them after the review. */
	private readonly reviews = new Map<string, PostedReviewComment[]>();
	/** Statuses are posted whole, so each update repeats what started the run. */
	private readonly checkRuns = new Map<
		string,
		{ headSha: string; name: string; detailsUrl?: string }
	>();
	/** The merge request of each conversation note this client read or wrote, to edit it by. */
	private readonly noteMergeRequests = new Map<string, number>();
	private project?: Promise<{ id: number; webUrl: string; cloneUrl: string }>;

	constructor(
		private readonly api: GitLabApi,
		private readonly path: string,
		private readonly token: () => Promise<string>,
		private readonly app: GitHubApp
	) {}

	async getInstallationToken(): Promise<GitCredential> {
		return { username: GIT_USERNAME, token: await this.token() };
	}

	async getPullRequest(pullNumber: number): Promise<PullRequest> {
		const [mr, project] = await Promise.all([this.mergeRequest(pullNumber), this.getProject()]);
		return {
			number: mr.iid,
			title: mr.title,
			body: mr.description ?? '',
			author: this.name(mr.author),
			// GitLab has no author association: trust comes from the member's access level.
			authorAssociation: '',
			botOnOwnBranch: false,
			draft: mr.draft,
			state: mr.state === 'opened' ? 'open' : 'closed',
			merged: mr.state === 'merged',
			baseRef: mr.target_branch,
			baseSha: mr.diff_refs?.start_sha ?? mr.diff_refs?.base_sha ?? '',
			headSha: mr.diff_refs?.head_sha ?? mr.sha,
			// GitLab keeps every merge request's head here, forks included.
			headRef: `refs/merge-requests/${mr.iid}/head`,
			cloneUrl: project.cloneUrl
		};
	}

	isTrustedAuthor(pr: { author: string }) {
		return this.hasWriteAccess(pr.author);
	}

	async hasWriteAccess(username: string): Promise<boolean> {
		try {
			const id = this.userIds.get(username) ?? (await this.userId(username));
			if (id === undefined) return false;
			const member = await this.api.request<{ access_level: number }>(
				'GET',
				`${this.path}/members/all/${id}`
			);
			return member.access_level >= DEVELOPER_ACCESS;
		} catch {
			return false;
		}
	}

	async getFileContent(path: string, gitRef: string): Promise<string | null> {
		try {
			return await this.api.raw(`${this.path}/repository/files/${encodeURIComponent(path)}/raw`, {
				ref: gitRef
			});
		} catch (error) {
			if (error instanceof GitLabError && error.status === 404) return null;
			throw error;
		}
	}

	/**
	 * Opens a discussion for each comment, then posts the body and the verdict. GitLab takes the
	 * discussions one at a time, so when it refuses one, those already opened are deleted again
	 * and the refusal is passed on: the engine then puts every finding in the body, as it does
	 * when GitHub refuses a review.
	 */
	async createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: string }> {
		const posted: PostedReviewComment[] = [];
		const notes: number[] = [];
		if (input.comments.length) {
			const anchor = await this.anchor(input.pullNumber, input.commitId);
			try {
				for (const comment of input.comments) {
					const discussion = await this.api.request<Discussion>(
						'POST',
						`${this.mergeRequestPath(input.pullNumber)}/discussions`,
						{ body: { body: comment.body, position: textPosition(anchor, comment) } }
					);
					notes.push(discussion.notes[0]!.id);
					posted.push({
						id: discussion.id,
						path: comment.path,
						line: comment.line,
						body: comment.body
					});
				}
			} catch (error) {
				if (error instanceof GitLabError && error.unprocessable) {
					await this.deleteNotes(input.pullNumber, notes);
				}
				throw error;
			}
		}
		const note = await this.api.request<Note>(
			'POST',
			`${this.mergeRequestPath(input.pullNumber)}/notes`,
			{ body: { body: input.body } }
		);
		await this.verdict(input.pullNumber, input.commitId, input.event);
		const id = String(note.id);
		this.reviews.set(id, posted);
		return { id };
	}

	async createFileComment(input: {
		pullNumber: number;
		commitId: string;
		path: string;
		body: string;
	}): Promise<string> {
		const anchor = await this.anchor(input.pullNumber, input.commitId);
		const file = anchor.files.find((f) => f.new_path === input.path);
		const discussion = await this.api.request<Discussion>(
			'POST',
			`${this.mergeRequestPath(input.pullNumber)}/discussions`,
			{
				body: {
					body: input.body,
					position: {
						position_type: 'file',
						base_sha: anchor.base_sha,
						start_sha: anchor.start_sha,
						head_sha: anchor.head_sha,
						new_path: input.path,
						old_path: file?.old_path ?? input.path
					}
				}
			}
		);
		return discussion.id;
	}

	async listPullRequestPatches(pullNumber: number): Promise<{ path: string; patch?: string }[]> {
		const files = await this.api.list<FileDiff>(`${this.mergeRequestPath(pullNumber)}/diffs`);
		return files.map((file) => ({
			path: file.new_path,
			...(file.diff ? { patch: file.diff.replace(/\n$/, '') } : {})
		}));
	}

	async listReviewComments(_pullNumber: number, reviewId: string): Promise<PostedReviewComment[]> {
		return this.reviews.get(reviewId) ?? [];
	}

	/** A review that requests changes only withdraws the approval, so none is left to dismiss. */
	async dismissChangeRequests(): Promise<number> {
		return 0;
	}

	async createIssueComment(issueNumber: number, body: string): Promise<void> {
		await this.api.request('POST', `${this.mergeRequestPath(issueNumber)}/notes`, {
			body: { body }
		});
	}

	/** Conversation notes are edited through their merge request, which the id alone lacks. */
	async updateIssueComment(commentId: string, body: string): Promise<void> {
		const pullNumber = this.noteMergeRequests.get(commentId);
		if (pullNumber === undefined) throw new Error(`note ${commentId} was not read by this client`);
		await this.api.request('PUT', `${this.mergeRequestPath(pullNumber)}/notes/${commentId}`, {
			body: { body }
		});
	}

	async getMarkedComment(
		issueNumber: number,
		marker: string
	): Promise<{ id: string; url: string; body: string } | null> {
		const existing = (await this.conversation(issueNumber)).find(
			(note) => this.isOwn(note.author) && note.body.includes(marker)
		);
		if (!existing) return null;
		const id = String(existing.id);
		this.noteMergeRequests.set(id, issueNumber);
		return { id, url: await this.noteUrl(issueNumber, id), body: existing.body };
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
		const created = await this.api.request<Note>(
			'POST',
			`${this.mergeRequestPath(issueNumber)}/notes`,
			{ body: { body } }
		);
		const id = String(created.id);
		this.noteMergeRequests.set(id, issueNumber);
		return { id, url: await this.noteUrl(issueNumber, id) };
	}

	async acknowledgeComment(pullNumber: number, comment: { id: string }): Promise<void> {
		await this.api.request(
			'POST',
			`${this.mergeRequestPath(pullNumber)}/notes/${encodeURIComponent(comment.id)}/award_emoji`,
			{ body: { name: 'eyes' } }
		);
	}

	async clearAcknowledgement(pullNumber: number, comment: { id: string }): Promise<void> {
		const path = `${this.mergeRequestPath(pullNumber)}/notes/${encodeURIComponent(comment.id)}/award_emoji`;
		const awards = await this.api.request<{ id: number; name: string; user: User }[]>('GET', path);
		for (const award of awards) {
			if (award.name !== 'eyes' || !this.isOwn(award.user)) continue;
			await this.api.request('DELETE', `${path}/${award.id}`);
		}
	}

	async getReviewThread(pullNumber: number, rootCommentId: string): Promise<ThreadComment[]> {
		const discussion = await this.api.request<Discussion>(
			'GET',
			`${this.mergeRequestPath(pullNumber)}/discussions/${encodeURIComponent(rootCommentId)}`
		);
		return discussion.notes.filter((note) => !note.system).map((note) => this.threadComment(note));
	}

	async getRecentIssueComments(
		issueNumber: number,
		limit = 20,
		untilId?: string
	): Promise<ThreadComment[]> {
		const notes = await this.conversation(issueNumber);
		const until = untilId === undefined ? -1 : notes.findIndex((n) => String(n.id) === untilId);
		const upTo = until === -1 ? notes : notes.slice(0, until + 1);
		return upTo.slice(-limit).map((note) => this.threadComment(note));
	}

	async replyToReviewComment(pullNumber: number, commentId: string, body: string): Promise<void> {
		await this.api.request(
			'POST',
			`${this.mergeRequestPath(pullNumber)}/discussions/${encodeURIComponent(commentId)}/notes`,
			{ body: { body } }
		);
	}

	async listReviewThreads(pullNumber: number): Promise<ReviewThread[]> {
		const discussions = await this.api.list<Discussion>(
			`${this.mergeRequestPath(pullNumber)}/discussions`
		);
		return discussions
			.filter((discussion) => discussion.notes[0]?.position)
			.map((discussion) => {
				const root = discussion.notes[0]!;
				const isResolved = discussion.notes.every((note) => !note.resolvable || note.resolved);
				return {
					id: discussion.id,
					isResolved,
					resolvedBy: isResolved && root.resolved_by ? this.name(root.resolved_by) : null,
					rootCommentId: discussion.id
				};
			});
	}

	async resolveReviewThreads(pullNumber: number, rootCommentIds: string[]): Promise<number> {
		let resolved = 0;
		for (const id of rootCommentIds) {
			await this.api.request(
				'PUT',
				`${this.mergeRequestPath(pullNumber)}/discussions/${encodeURIComponent(id)}`,
				{ query: { resolved: true } }
			);
			resolved++;
		}
		return resolved;
	}

	async getLinkedIssues(pullNumber: number): Promise<LinkedIssueRef[]> {
		const [issues, project] = await Promise.all([
			this.api.list<{ iid: number; project_id: number; title: string; description: string | null }>(
				`${this.mergeRequestPath(pullNumber)}/closes_issues`
			),
			this.getProject()
		]);
		return issues
			.filter((issue) => issue.project_id === project.id)
			.slice(0, MAX_LINKED_ISSUES)
			.map((issue) => ({
				number: issue.iid,
				title: issue.title,
				body: truncate(issue.description ?? '', MAX_ISSUE_BODY_CHARS)
			}));
	}

	/** Failed commit statuses, CI jobs among them, except the bot's own and allowed failures. */
	async getFailedChecks(headSha: string, ownAppId: string): Promise<FailedCheckRun[]> {
		const statuses = await this.api.list<Status>(
			`${this.path}/repository/commits/${encodeURIComponent(headSha)}/statuses`
		);
		return statuses
			.filter(
				(status) =>
					status.status === 'failed' &&
					!status.allow_failure &&
					String(status.author?.id) !== ownAppId
			)
			.slice(0, MAX_FAILED_CHECKS)
			.map((status) => ({
				name: status.name,
				conclusion: 'failure',
				output: [status.description, status.target_url].filter(Boolean).join('\n\n'),
				annotations: []
			}));
	}

	/**
	 * Posts the bot's commit status. GitLab keeps one per name and commit, so starting again on the
	 * same commit takes over the one the bot left running. `externalId` names it apart from another
	 * project's.
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
			name: input.externalId ? `${input.name} (${input.externalId})` : input.name,
			...(input.detailsUrl ? { detailsUrl: input.detailsUrl } : {})
		};
		const id = `${run.headSha}:${run.name}`;
		this.checkRuns.set(id, run);
		await this.postStatus(run, 'running', input.output?.title);
		return id;
	}

	async updateCheckRun(checkRunId: string, output: { title: string; summary: string }) {
		await this.postStatus(this.checkRun(checkRunId), 'running', output.title);
	}

	async completeCheckRun(
		checkRunId: string,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void> {
		await this.postStatus(this.checkRun(checkRunId), states[input.conclusion], input.title);
	}

	/** The project's numeric id and web and clone URLs, read once. */
	getProject() {
		this.project ??= this.api
			.request<{ id: number; web_url: string; http_url_to_repo: string }>('GET', this.path)
			.then((project) => ({
				id: project.id,
				webUrl: project.web_url.replace(/\/+$/, ''),
				cloneUrl: project.http_url_to_repo
			}));
		return this.project;
	}

	private async postStatus(
		run: { headSha: string; name: string; detailsUrl?: string },
		state: string,
		description?: string
	): Promise<void> {
		try {
			await this.api.request('POST', `${this.path}/statuses/${encodeURIComponent(run.headSha)}`, {
				body: {
					state,
					name: run.name,
					...(description ? { description: truncate(description, MAX_DESCRIPTION_CHARS) } : {}),
					...(run.detailsUrl ? { target_url: run.detailsUrl } : {})
				}
			});
		} catch (error) {
			// GitLab refuses to move a running status to running again; it is already where it
			// should be, and only its description stays behind.
			if (state === 'running' && error instanceof GitLabError && error.status === 400) return;
			throw error;
		}
	}

	private checkRun(id: string) {
		const run = this.checkRuns.get(id);
		if (!run) throw new Error(`check run ${id} was not started by this client`);
		return run;
	}

	private async verdict(pullNumber: number, sha: string, event: ReviewEvent): Promise<void> {
		if (event === 'COMMENT') return;
		try {
			if (event === 'APPROVE') {
				await this.api.request('POST', `${this.mergeRequestPath(pullNumber)}/approve`, {
					body: { sha }
				});
			} else {
				await this.api.request('POST', `${this.mergeRequestPath(pullNumber)}/unapprove`);
			}
		} catch (error) {
			// Already approved, not approved, or approvals not open to the bot: the body stands.
			if (error instanceof GitLabError && [401, 403, 404, 405].includes(error.status)) return;
			throw error;
		}
	}

	/**
	 * The diff version of the commit a review is about, so a position stays on the lines the
	 * review read even when a newer push landed meanwhile. The latest diff when GitLab has none.
	 */
	private async anchor(pullNumber: number, commitId: string): Promise<Anchor> {
		const mr = this.mergeRequestPath(pullNumber);
		const versions = await this.api.list<Version>(`${mr}/versions`);
		const version = versions.find((v) => v.head_commit_sha === commitId);
		if (version) {
			const detail = await this.api.request<Version & { diffs: FileDiff[] }>(
				'GET',
				`${mr}/versions/${version.id}`
			);
			return {
				base_sha: version.base_commit_sha,
				start_sha: version.start_commit_sha,
				head_sha: version.head_commit_sha,
				files: detail.diffs
			};
		}
		const [request, files] = await Promise.all([
			this.mergeRequest(pullNumber),
			this.api.list<FileDiff>(`${mr}/diffs`)
		]);
		const refs = request.diff_refs;
		return {
			base_sha: refs?.base_sha ?? '',
			start_sha: refs?.start_sha ?? '',
			head_sha: refs?.head_sha ?? commitId,
			files
		};
	}

	private async deleteNotes(pullNumber: number, notes: number[]): Promise<void> {
		for (const note of notes) {
			await this.api
				.request('DELETE', `${this.mergeRequestPath(pullNumber)}/notes/${note}`)
				.catch(() => {});
		}
	}

	private mergeRequest(pullNumber: number) {
		return this.api.request<MergeRequest>('GET', this.mergeRequestPath(pullNumber));
	}

	private mergeRequestPath(pullNumber: number): string {
		return `${this.path}/merge_requests/${pullNumber}`;
	}

	/** Notes in the conversation, oldest first: neither GitLab's own nor on the diff. */
	private async conversation(pullNumber: number): Promise<Note[]> {
		const notes = await this.api.list<Note>(`${this.mergeRequestPath(pullNumber)}/notes`, {
			sort: 'asc',
			order_by: 'created_at'
		});
		return notes.filter((note) => !note.system && !note.position);
	}

	private async userId(username: string): Promise<number | undefined> {
		const users = await this.api.request<User[]>('GET', '/users', { query: { username } });
		return users[0]?.id;
	}

	private threadComment(note: Note): ThreadComment {
		const line = note.position?.new_line ?? note.position?.old_line ?? null;
		return {
			id: String(note.id),
			author: this.name(note.author),
			body: note.body,
			isBot: this.isOwn(note.author) || !!note.author.bot,
			...(note.position ? { path: note.position.new_path ?? note.position.old_path, line } : {})
		};
	}

	/** The name the engine knows a user by: the username, and the bot `<slug>[bot]`, as on GitHub. */
	private name(user: User): string {
		this.userIds.set(user.username, user.id);
		return this.isOwn(user) ? `${this.app.slug}[bot]` : user.username;
	}

	private isOwn(user: User | undefined): boolean {
		return user !== undefined && String(user.id) === this.app.id;
	}

	private async noteUrl(pullNumber: number, noteId: string): Promise<string> {
		const { webUrl } = await this.getProject();
		return `${webUrl}/-/merge_requests/${pullNumber}#note_${noteId}`;
	}
}

/**
 * A comment's position on the new side. GitLab anchors a line by both its numbers, so a context
 * line also needs its old one, which the file's hunks give. A range is posted on its last line.
 */
function textPosition(anchor: Anchor, comment: ReviewComment) {
	const file = anchor.files.find((f) => f.new_path === comment.path);
	const oldLine = file ? contextLines(file.diff).get(comment.line) : undefined;
	return {
		position_type: 'text',
		base_sha: anchor.base_sha,
		start_sha: anchor.start_sha,
		head_sha: anchor.head_sha,
		new_path: comment.path,
		old_path: file?.old_path ?? comment.path,
		new_line: comment.line,
		...(oldLine === undefined ? {} : { old_line: oldLine })
	};
}

/** Old line numbers of the unchanged lines in a patch, by their new line number. */
export function contextLines(patch: string): Map<number, number> {
	const lines = new Map<number, number>();
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split('\n')) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
		} else if (line.startsWith('+')) {
			newLine++;
		} else if (line.startsWith('-')) {
			oldLine++;
		} else if (line.startsWith(' ')) {
			lines.set(newLine, oldLine);
			oldLine++;
			newLine++;
		}
	}
	return lines;
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
