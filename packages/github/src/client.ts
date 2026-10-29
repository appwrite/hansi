import type {
	GitHubClient,
	GitHubClientFactory,
	GitHubConnection,
	PostedReviewComment
} from '@hansi/engine';
import { Octokit } from 'octokit';
import * as pulls from './pulls';
import type { InstallationToken, InstallationTokens } from './tokens';

// The engine's GitHub client on octokit, which brings the retry and throttling GitHub's rate
// limits need. Appwrite mints the installation tokens; this client only holds short-lived ones.

export interface GitHubConfig {
	/** REST API root. GitHub Enterprise Server uses `https://<host>/api/v3`. */
	apiUrl?: string;
	fetch?: typeof fetch;
}

/** Tokens are renewed this long before they expire, so a request never races the expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export class InstallationGitHubClientFactory implements GitHubClientFactory {
	constructor(
		private readonly tokens: InstallationTokens,
		private readonly config: GitHubConfig = {}
	) {}

	async forRepository(repository: {
		projectId: string;
		repositoryId: string;
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

		const octokit = new Octokit({
			...(this.config.apiUrl ? { baseUrl: this.config.apiUrl.replace(/\/+$/, '') } : {}),
			...(this.config.fetch ? { request: { fetch: this.config.fetch } } : {})
		});
		octokit.hook.before('request', async (options) => {
			options.headers.authorization = `token ${await token()}`;
		});

		const ref = { owner: repository.owner, repo: repository.name };
		return { github: new OctokitGitHubClient(octokit, ref, token), app: current.app };
	}
}

export class OctokitGitHubClient implements GitHubClient {
	constructor(
		private readonly octokit: Octokit,
		private readonly ref: pulls.RepoRef,
		private readonly token: () => Promise<string>
	) {}

	getInstallationToken() {
		return this.token();
	}

	getPullRequest(pullNumber: number) {
		return pulls.getPullRequest(this.octokit, this.ref, pullNumber);
	}

	isTrustedAuthor(pr: { author: string; authorAssociation: string }) {
		return pulls.isTrustedAuthor(this.octokit, this.ref, pr);
	}

	hasWriteAccess(username: string) {
		return pulls.hasWriteAccess(this.octokit, this.ref, username);
	}

	/** GitHub answers the tarball endpoint with a redirect to a short-lived download URL. */
	async getArchiveUrl(ref: string) {
		const { headers } = await this.octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
			...this.ref,
			ref,
			request: { redirect: 'manual' }
		});
		if (!headers.location) throw new Error(`GitHub returned no archive URL for ${ref}`);
		return headers.location;
	}

	getFileContent(path: string, gitRef: string) {
		return pulls.getFileContent(this.octokit, this.ref, path, gitRef);
	}

	async createReview(input: Parameters<GitHubClient['createReview']>[0]) {
		const { id } = await pulls.createReview(this.octokit, this.ref, input);
		return { id };
	}

	createFileComment(input: Parameters<GitHubClient['createFileComment']>[0]) {
		return pulls.createFileComment(this.octokit, this.ref, input);
	}

	listPullRequestPatches(pullNumber: number) {
		return pulls.listPullRequestPatches(this.octokit, this.ref, pullNumber);
	}

	async listReviewComments(pullNumber: number, reviewId: number): Promise<PostedReviewComment[]> {
		const comments = await pulls.listReviewComments(this.octokit, this.ref, pullNumber, reviewId);
		return comments.map((c) => ({ id: c.id, path: c.path, line: c.line, body: c.body }));
	}

	dismissChangeRequests(pullNumber: number, input: { botLogin: string; message: string }) {
		return pulls.dismissChangeRequests(this.octokit, this.ref, pullNumber, input);
	}

	createIssueComment(issueNumber: number, body: string) {
		return pulls.createIssueComment(this.octokit, this.ref, issueNumber, body);
	}

	updateIssueComment(commentId: number, body: string) {
		return pulls.updateIssueComment(this.octokit, this.ref, commentId, body);
	}

	getMarkedComment(issueNumber: number, marker: string) {
		return pulls.getMarkedComment(this.octokit, this.ref, issueNumber, marker);
	}

	upsertMarkedComment(issueNumber: number, marker: string, body: string) {
		return pulls.upsertMarkedComment(this.octokit, this.ref, issueNumber, marker, body);
	}

	acknowledgeComment(comment: { id: number; kind: 'issue' | 'review' }) {
		return pulls.acknowledgeComment(this.octokit, this.ref, comment);
	}

	getReviewThread(pullNumber: number, rootCommentId: number) {
		return pulls.getReviewThread(this.octokit, this.ref, pullNumber, rootCommentId);
	}

	getRecentIssueComments(issueNumber: number, limit?: number) {
		return pulls.getRecentIssueComments(this.octokit, this.ref, issueNumber, limit);
	}

	replyToReviewComment(pullNumber: number, commentId: number, body: string) {
		return pulls.replyToReviewComment(this.octokit, this.ref, pullNumber, commentId, body);
	}

	listReviewThreads(pullNumber: number) {
		return pulls.listReviewThreads(this.octokit, this.ref, pullNumber);
	}

	resolveReviewThreads(pullNumber: number, rootCommentIds: number[]) {
		return pulls.resolveReviewThreads(this.octokit, this.ref, pullNumber, rootCommentIds);
	}

	getLinkedIssues(pullNumber: number) {
		return pulls.getLinkedIssues(this.octokit, this.ref, pullNumber);
	}

	getFailedChecks(headSha: string, ownAppId: string) {
		return pulls.getFailedChecks(this.octokit, this.ref, headSha, ownAppId);
	}

	startCheckRun(input: Parameters<GitHubClient['startCheckRun']>[0]) {
		return pulls.startCheckRun(this.octokit, this.ref, input);
	}

	updateCheckRun(checkRunId: number, output: { title: string; summary: string }) {
		return pulls.updateCheckRun(this.octokit, this.ref, checkRunId, output);
	}

	completeCheckRun(checkRunId: number, input: Parameters<GitHubClient['completeCheckRun']>[1]) {
		return pulls.completeCheckRun(this.octokit, this.ref, checkRunId, input);
	}
}
