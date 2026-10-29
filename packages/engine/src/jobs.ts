// The work Appwrite hands to the review service. Appwrite owns the webhook intake, decides
// which project reviews a repository, and coalesces one pending review per pull request; the
// service only ever sees the job that came out of that.

/**
 * A repository with code review turned on: an Appwrite `repositories` row with
 * `resourceType = 'reviews'`, plus the GitHub identifiers needed to act on it.
 */
export interface Repository {
	/** Appwrite project that owns the review. Review data lives in its database. */
	projectId: string;
	projectInternalId: string;
	/** `$id` of the `repositories` row. */
	repositoryId: string;
	/** `$id` of the Appwrite `installations` row the repository was linked through. */
	installationId: string;
	/** GitHub App installation id, the one installation tokens are minted for. */
	providerInstallationId: string;
	/** GitHub repository id. Stable across renames, unlike owner and name. */
	providerRepositoryId: string;
	owner: string;
	name: string;
	/** The Console's root, for links to a review. Absent when Appwrite has none to give. */
	consoleUrl?: string;
}

/** The comment that asked for work: on the pull request conversation, or in a review thread. */
export interface CommentRef {
	id: number;
	kind: 'issue' | 'review';
}

/** A pull request marked ready for review counts as opened. */
export type ReviewTrigger =
	{ kind: 'opened' | 'synchronize' | 'retry' } | { kind: 'mention'; comment: CommentRef };

/** Review one pull request at one head. Appwrite created the review document already. */
export interface ReviewJob {
	type: 'review';
	/** `$id` of the review document in the project database. */
	reviewId: string;
	repository: Repository;
	pullNumber: number;
	/**
	 * The head when the review was queued, empty for a mention. The job reviews whatever the head
	 * is when it runs.
	 */
	headSha: string;
	trigger: ReviewTrigger;
}

/** Answer one comment on a pull request. */
export interface ChatJob {
	type: 'chat';
	repository: Repository;
	pullNumber: number;
	comment: CommentRef & {
		/** For review threads: the first comment of the thread, which replies attach to. */
		rootCommentId?: number;
		author: string;
		/**
		 * GitHub `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …), as
		 * GitHub reported it, never derived from the comment body.
		 */
		authorAssociation: string;
		url: string;
	};
	/**
	 * A comment that does not mention the bot. A review-thread reply is answered only when it
	 * replies to one of the bot's own comments; a conversation comment only when it names an
	 * open finding listed in a review body.
	 */
	unmentioned?: boolean;
}

export type Job = ReviewJob | ChatJob;
