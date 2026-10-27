import type {
	CheckRun,
	FailedCheck,
	GitHubClient,
	GitHubClientFactory,
	GitRemote,
	InlineComment,
	PullRequest,
	PullRequestFile,
	Reaction,
	ReviewComment,
	ReviewEvent
} from '@hansi/engine';
import type { InstallationToken, InstallationTokens } from './tokens';

// GitHub's REST API (and GraphQL where REST has no endpoint), authenticated as one installation
// of the GitHub App. Appwrite mints the tokens; this client only ever holds short-lived ones.

export interface GitHubConfig {
	/** REST API root. GitHub Enterprise Server uses `https://<host>/api/v3`. */
	apiUrl?: string;
	/** GraphQL endpoint. Defaults to `<apiUrl>/graphql`. */
	graphqlUrl?: string;
	/** Web root for git remotes. */
	webUrl?: string;
	fetch?: typeof fetch;
}

export class GitHubError extends Error {
	override readonly name = 'GitHubError';

	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		body: string
	) {
		super(`GitHub ${method} ${path} returned ${status}: ${body.slice(0, 500)}`);
	}
}

/** Tokens are renewed this long before they expire, so a request never races the expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const PAGE_SIZE = 100;
/** GitHub lists at most 3000 files for a pull request. */
const MAX_PAGES = 30;

export class InstallationGitHubClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: GitHubConfig = {}
	) {}

	async forRepository(repository: {
		providerInstallationId: string;
		owner: string;
		name: string;
	}): Promise<GitHubClient> {
		let current: InstallationToken | null = null;
		const token = async () => {
			if (!current || current.expiresAt.getTime() - Date.now() < TOKEN_MARGIN_MS) {
				current = await this.tokens.get(repository.providerInstallationId);
			}
			return current.token;
		};
		return new RestGitHubClient(repository.owner, repository.name, token, this.config);
	}
}

interface RawUser {
	login: string;
}

interface RawPullRequest {
	number: number;
	title: string;
	body: string | null;
	user: RawUser | null;
	author_association: string;
	draft?: boolean;
	state: 'open' | 'closed';
	merged?: boolean;
	merged_at?: string | null;
	base: { ref: string; sha: string };
	head: { ref: string; sha: string };
	html_url: string;
}

interface RawFile {
	filename: string;
	previous_filename?: string;
	status: PullRequestFile['status'];
	additions: number;
	deletions: number;
	patch?: string;
}

interface RawReviewComment {
	id: number;
	path: string;
	line?: number | null;
	body: string;
	user: RawUser | null;
	in_reply_to_id?: number;
	html_url: string;
	pull_request_url: string;
}

interface RawCheckRun {
	name: string;
	conclusion: string | null;
	html_url: string;
	details_url?: string | null;
	output?: { summary?: string | null };
}

export class RestGitHubClient implements GitHubClient {
	private readonly api: string;
	private readonly graphqlUrl: string;
	private readonly web: string;
	private readonly http: typeof fetch;

	constructor(
		private readonly owner: string,
		private readonly name: string,
		private readonly token: () => Promise<string>,
		config: GitHubConfig = {}
	) {
		this.api = (config.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
		this.graphqlUrl = config.graphqlUrl ?? `${this.api}/graphql`;
		this.web = (config.webUrl ?? 'https://github.com').replace(/\/+$/, '');
		this.http = config.fetch ?? fetch;
	}

	private get repo(): string {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.http(`${this.api}${path}`, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${await this.token()}`,
				'x-github-api-version': '2022-11-28',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok) {
			throw new GitHubError(response.status, method, path, await response.text());
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private async paginate<T>(path: string): Promise<T[]> {
		const items: T[] = [];
		const separator = path.includes('?') ? '&' : '?';
		for (let page = 1; page <= MAX_PAGES; page++) {
			const batch = await this.request<T[]>(
				'GET',
				`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`
			);
			items.push(...batch);
			if (batch.length < PAGE_SIZE) break;
		}
		return items;
	}

	private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const response = await this.http(this.graphqlUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await this.token()}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ query, variables })
		});
		const text = await response.text();
		if (!response.ok) throw new GitHubError(response.status, 'POST', '/graphql', text);
		const result = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
		if (result.errors?.length || !result.data) {
			throw new GitHubError(response.status, 'POST', '/graphql', text);
		}
		return result.data;
	}

	async gitRemote(): Promise<GitRemote> {
		return { url: `${this.web}/${this.owner}/${this.name}.git`, token: await this.token() };
	}

	async getPullRequest(pullNumber: number): Promise<PullRequest> {
		const pr = await this.request<RawPullRequest>('GET', `${this.repo}/pulls/${pullNumber}`);
		return {
			number: pr.number,
			title: pr.title,
			body: pr.body ?? '',
			author: pr.user?.login ?? 'ghost',
			authorAssociation: pr.author_association,
			draft: pr.draft ?? false,
			state: pr.state,
			merged: pr.merged ?? Boolean(pr.merged_at),
			base: { ref: pr.base.ref, sha: pr.base.sha },
			head: { ref: pr.head.ref, sha: pr.head.sha },
			url: pr.html_url
		};
	}

	async listPullRequestFiles(pullNumber: number): Promise<PullRequestFile[]> {
		const files = await this.paginate<RawFile>(`${this.repo}/pulls/${pullNumber}/files`);
		return files.map((file) => ({
			path: file.filename,
			previousPath: file.previous_filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			patch: file.patch
		}));
	}

	async getArchiveUrl(ref: string): Promise<string> {
		// GitHub answers with a redirect to a short-lived, pre-signed URL.
		const response = await this.http(`${this.api}${this.repo}/tarball/${encodeURIComponent(ref)}`, {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${await this.token()}`
			},
			redirect: 'manual'
		});
		const location = response.headers.get('location');
		if (response.status !== 302 || !location) {
			throw new GitHubError(response.status, 'GET', `${this.repo}/tarball`, await response.text());
		}
		return location;
	}

	async listFailedChecks(ref: string): Promise<FailedCheck[]> {
		const { check_runs: runs } = await this.request<{ check_runs: RawCheckRun[] }>(
			'GET',
			`${this.repo}/commits/${encodeURIComponent(ref)}/check-runs?filter=latest&per_page=100`
		);
		return runs
			.filter((run) => ['failure', 'timed_out', 'action_required'].includes(run.conclusion ?? ''))
			.map((run) => ({
				name: run.name,
				conclusion: run.conclusion ?? '',
				url: run.details_url ?? run.html_url,
				summary: run.output?.summary ?? undefined
			}));
	}

	async listReviewComments(pullNumber: number): Promise<ReviewComment[]> {
		const comments = await this.paginate<RawReviewComment>(
			`${this.repo}/pulls/${pullNumber}/comments`
		);
		return comments.map((comment) => ({
			id: comment.id,
			path: comment.path,
			line: comment.line ?? undefined,
			body: comment.body,
			author: comment.user?.login ?? 'ghost',
			inReplyToId: comment.in_reply_to_id,
			url: comment.html_url
		}));
	}

	async createReview(
		pullNumber: number,
		review: { commitId: string; event: ReviewEvent; body: string; comments: InlineComment[] }
	): Promise<{ id: number; url: string }> {
		const created = await this.request<{ id: number; html_url: string }>(
			'POST',
			`${this.repo}/pulls/${pullNumber}/reviews`,
			{
				commit_id: review.commitId,
				event: review.event,
				body: review.body,
				comments: review.comments.map((comment) => ({
					path: comment.path,
					line: comment.line,
					side: comment.side,
					body: comment.body,
					...(comment.startLine !== undefined && comment.startLine !== comment.line
						? { start_line: comment.startLine, start_side: comment.side }
						: {})
				}))
			}
		);
		return { id: created.id, url: created.html_url };
	}

	async replyToReviewComment(
		pullNumber: number,
		commentId: number,
		body: string
	): Promise<{ id: number }> {
		const created = await this.request<{ id: number }>(
			'POST',
			`${this.repo}/pulls/${pullNumber}/comments/${commentId}/replies`,
			{ body }
		);
		return { id: created.id };
	}

	async resolveThread(commentId: number): Promise<void> {
		// REST cannot resolve threads, and GraphQL finds a thread only through its pull request.
		const comment = await this.request<RawReviewComment>(
			'GET',
			`${this.repo}/pulls/comments/${commentId}`
		);
		const pullNumber = Number(comment.pull_request_url.split('/').pop());
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const data: ThreadsPage = await this.graphql<ThreadsPage>(THREADS_QUERY, {
				owner: this.owner,
				name: this.name,
				number: pullNumber,
				cursor
			});
			const threads = data.repository.pullRequest.reviewThreads;
			const thread = threads.nodes.find((t) =>
				t.comments.nodes.some((c) => c.databaseId === commentId)
			);
			if (thread) {
				if (!thread.isResolved) {
					await this.graphql(RESOLVE_MUTATION, { threadId: thread.id });
				}
				return;
			}
			if (!threads.pageInfo.hasNextPage) break;
			cursor = threads.pageInfo.endCursor;
		}
		throw new Error(`No review thread holds comment ${commentId}`);
	}

	async createIssueComment(
		issueNumber: number,
		body: string
	): Promise<{ id: number; url: string }> {
		const created = await this.request<{ id: number; html_url: string }>(
			'POST',
			`${this.repo}/issues/${issueNumber}/comments`,
			{ body }
		);
		return { id: created.id, url: created.html_url };
	}

	async updateIssueComment(commentId: number, body: string): Promise<void> {
		await this.request('PATCH', `${this.repo}/issues/comments/${commentId}`, { body });
	}

	async addReaction(
		comment: { id: number; kind: 'issue' | 'review' },
		reaction: Reaction
	): Promise<void> {
		const kind = comment.kind === 'issue' ? 'issues' : 'pulls';
		await this.request('POST', `${this.repo}/${kind}/comments/${comment.id}/reactions`, {
			content: reaction
		});
	}

	async createCheckRun(run: CheckRun): Promise<{ id: number }> {
		const created = await this.request<{ id: number }>(
			'POST',
			`${this.repo}/check-runs`,
			checkRunBody(run)
		);
		return { id: created.id };
	}

	async updateCheckRun(id: number, run: Partial<CheckRun>): Promise<void> {
		await this.request('PATCH', `${this.repo}/check-runs/${id}`, checkRunBody(run));
	}
}

function checkRunBody(run: Partial<CheckRun>): Record<string, unknown> {
	return {
		...(run.name !== undefined ? { name: run.name } : {}),
		...(run.headSha !== undefined ? { head_sha: run.headSha } : {}),
		...(run.status !== undefined ? { status: run.status } : {}),
		...(run.conclusion !== undefined ? { conclusion: run.conclusion } : {}),
		...(run.detailsUrl !== undefined ? { details_url: run.detailsUrl } : {}),
		...(run.title !== undefined || run.summary !== undefined
			? // GitHub rejects an output without both.
				{ output: { title: run.title ?? '', summary: run.summary ?? run.title ?? '' } }
			: {})
	};
}

interface ThreadsPage {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: {
					id: string;
					isResolved: boolean;
					comments: { nodes: { databaseId: number }[] };
				}[];
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		};
	};
}

const THREADS_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviewThreads(first: 100, after: $cursor) {
				nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
				pageInfo { hasNextPage endCursor }
			}
		}
	}
}`;

const RESOLVE_MUTATION = `mutation ($threadId: ID!) {
	resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;
