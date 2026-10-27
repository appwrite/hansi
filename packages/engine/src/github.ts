// What the engine needs from GitHub, for one installation. Appwrite owns the GitHub App and
// mints installation tokens; the client authenticates with them and never sees the app key.

export interface PullRequest {
	number: number;
	title: string;
	body: string;
	author: string;
	authorAssociation: string;
	draft: boolean;
	state: 'open' | 'closed';
	merged: boolean;
	base: { ref: string; sha: string };
	head: { ref: string; sha: string };
	url: string;
}

export interface PullRequestFile {
	path: string;
	previousPath?: string;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	additions: number;
	deletions: number;
	/** Absent when GitHub leaves the patch out (binary or too large). */
	patch?: string;
}

export interface ReviewComment {
	id: number;
	path: string;
	line?: number;
	body: string;
	author: string;
	inReplyToId?: number;
	url: string;
}

export interface InlineComment {
	path: string;
	line: number;
	/** First line of a multi-line comment. */
	startLine?: number;
	side: 'LEFT' | 'RIGHT';
	body: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmittedReview {
	id: number;
	body: string;
	commitId: string;
	url: string;
}

export interface CheckRun {
	name: string;
	headSha: string;
	status: 'queued' | 'in_progress' | 'completed';
	conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'action_required';
	title?: string;
	summary?: string;
	detailsUrl?: string;
}

export interface FailedCheck {
	name: string;
	conclusion: string;
	url: string;
	summary?: string;
}

export type Reaction = 'eyes' | '+1' | 'confused' | 'rocket';

/** Where to fetch the repository with git, and the token to send (absent for public test remotes). */
export interface GitRemote {
	url: string;
	token?: string;
}

export interface GitHubClient {
	/** A fresh remote for git. The token is short-lived: ask again for each checkout. */
	gitRemote(): Promise<GitRemote>;
	getPullRequest(pullNumber: number): Promise<PullRequest>;
	listPullRequestFiles(pullNumber: number): Promise<PullRequestFile[]>;
	/** A short-lived URL to a tarball of the repository at `ref`, for the checkout and sandbox. */
	getArchiveUrl(ref: string): Promise<string>;
	listFailedChecks(ref: string): Promise<FailedCheck[]>;

	listReviews(pullNumber: number): Promise<SubmittedReview[]>;
	listReviewComments(pullNumber: number): Promise<ReviewComment[]>;
	createReview(
		pullNumber: number,
		review: { commitId: string; event: ReviewEvent; body: string; comments: InlineComment[] }
	): Promise<{ id: number; url: string }>;
	replyToReviewComment(
		pullNumber: number,
		commentId: number,
		body: string
	): Promise<{ id: number }>;
	/** Resolves the review thread a comment belongs to (GraphQL only). */
	resolveThread(commentId: number): Promise<void>;

	createIssueComment(issueNumber: number, body: string): Promise<{ id: number; url: string }>;
	updateIssueComment(commentId: number, body: string): Promise<void>;
	addReaction(comment: { id: number; kind: 'issue' | 'review' }, reaction: Reaction): Promise<void>;

	createCheckRun(run: CheckRun): Promise<{ id: number }>;
	updateCheckRun(id: number, run: Partial<CheckRun>): Promise<void>;
}

/** Opens a client for one repository, through the installation it is reviewed by. */
export interface GitHubClientFactory {
	forRepository(repository: {
		providerInstallationId: string;
		owner: string;
		name: string;
	}): Promise<GitHubClient>;
}
