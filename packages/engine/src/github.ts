// What the engine needs from GitHub, for one repository. Appwrite owns the GitHub App and mints
// installation tokens; the client authenticates with them and never sees the app key. The calls
// match hansi.codes' GitHub helpers one for one, so both post the same thing.

export interface PullRequest {
	number: number;
	title: string;
	body: string;
	author: string;
	authorAssociation: string;
	draft: boolean;
	state: string;
	/** True once the pull request has been merged. Closed-without-merge stays false. */
	merged: boolean;
	baseRef: string;
	baseSha: string;
	headSha: string;
	cloneUrl: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewComment {
	path: string;
	/** Right-side line in the new file; must be part of the diff. */
	line: number;
	startLine?: number;
	body: string;
}

/** A comment GitHub created for a review. */
export interface PostedReviewComment {
	id: number;
	path: string;
	line?: number | null;
	body: string;
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

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	/** Who resolved the thread, when it is resolved and GitHub still knows the account. */
	resolvedBy: string | null;
	/** Database id of the thread's first comment, which is how findings are linked. */
	rootCommentId: number | undefined;
}

export interface LinkedIssueRef {
	number: number;
	title: string;
	body: string;
}

export interface FailedCheckRun {
	name: string;
	conclusion: string;
	output: string;
	annotations: { path: string; line: number; message: string }[];
}

export type CheckConclusion = 'success' | 'neutral' | 'failure' | 'skipped' | 'cancelled';

export interface GitHubClient {
	/** A short-lived installation token for git. Ask again for each checkout. */
	getInstallationToken(): Promise<string>;
	getPullRequest(pullNumber: number): Promise<PullRequest>;
	/**
	 * Whether the PR author can write to the repository: the author association first, then the
	 * actual repository permission. Errors count as untrusted.
	 */
	isTrustedAuthor(pr: { author: string; authorAssociation: string }): Promise<boolean>;
	/** Whether an account can write to the repository. Errors count as no. */
	hasWriteAccess(username: string): Promise<boolean>;
	/** A short-lived URL to a tarball of the repository at `ref`, for the sandbox. */
	getArchiveUrl(ref: string): Promise<string>;
	/** Reads a file at a ref, or `null` when it does not exist. */
	getFileContent(path: string, gitRef: string): Promise<string | null>;

	createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: number }>;
	/** Comments on a whole file. Returns the comment id, the root of a thread. */
	createFileComment(input: {
		pullNumber: number;
		commitId: string;
		path: string;
		body: string;
	}): Promise<number>;
	/** The pull request's files as GitHub shows them; `patch` is missing where GitHub shows none. */
	listPullRequestPatches(pullNumber: number): Promise<{ path: string; patch?: string }[]>;
	listReviewComments(pullNumber: number, reviewId: number): Promise<PostedReviewComment[]>;
	/** Dismisses the bot's own "changes requested" reviews. Returns how many it dismissed. */
	dismissChangeRequests(
		pullNumber: number,
		input: { botLogin: string; message: string }
	): Promise<number>;

	createIssueComment(issueNumber: number, body: string): Promise<void>;
	updateIssueComment(commentId: number, body: string): Promise<void>;
	/** The bot's marked comment on an issue, if one exists. */
	getMarkedComment(
		issueNumber: number,
		marker: string
	): Promise<{ id: number; url: string; body: string } | null>;
	/** Creates the marked comment on first use and edits it afterwards. */
	upsertMarkedComment(
		issueNumber: number,
		marker: string,
		body: string
	): Promise<{ id: number; url: string }>;
	/** Acknowledges a comment with 👀. */
	acknowledgeComment(comment: { id: number; kind: 'issue' | 'review' }): Promise<void>;

	/** A review comment thread: the root comment and its replies, oldest first. */
	getReviewThread(pullNumber: number, rootCommentId: number): Promise<ThreadComment[]>;
	/** The most recent conversation comments, oldest first. */
	getRecentIssueComments(issueNumber: number, limit?: number): Promise<ThreadComment[]>;
	replyToReviewComment(pullNumber: number, commentId: number, body: string): Promise<void>;
	listReviewThreads(pullNumber: number): Promise<ReviewThread[]>;
	/** Resolves the threads that start with these comments. Returns how many it resolved. */
	resolveReviewThreads(pullNumber: number, rootCommentIds: number[]): Promise<number>;

	/** Issues the pull request resolves, from the same repository only. */
	getLinkedIssues(pullNumber: number): Promise<LinkedIssueRef[]>;
	/** Check runs that already failed on a commit, excluding the app's own. */
	getFailedChecks(headSha: string, ownAppId: string): Promise<FailedCheckRun[]>;

	/** Starts the app's check run, taking over one it left in progress. */
	startCheckRun(input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		ownAppId?: string;
		output?: { title: string; summary: string };
	}): Promise<number>;
	updateCheckRun(checkRunId: number, output: { title: string; summary: string }): Promise<void>;
	completeCheckRun(
		checkRunId: number,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void>;
}

/** The GitHub App the client acts as. */
export interface GitHubApp {
	id: string;
	/** The app's slug: users mention `@<slug>`, and its account is `<slug>[bot]`. */
	slug: string;
}

/** A repository the engine can act on, and the app it acts as. */
export interface GitHubConnection {
	github: GitHubClient;
	app: GitHubApp;
}

/** Opens a client for one repository, with tokens scoped to it. */
export interface GitHubClientFactory {
	forRepository(repository: {
		projectId: string;
		repositoryId: string;
		owner: string;
		name: string;
	}): Promise<GitHubConnection>;
}

/** Whether GitHub refused a request as unprocessable, e.g. a comment on a line it has no diff for. */
export function isUnprocessable(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error as { status: unknown }).status === 422
	);
}
