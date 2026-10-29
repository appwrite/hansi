// Where review outcomes live. Appwrite stores them in the project's database and the Console
// reads them from there; GitHub gets its own copy through the GitHubClient. The engine also
// reads the pull request's earlier reviews and findings back, to review only what changed and
// to keep the summary comment, the threads and the grade in step.

import type { Severity, Tier, Verdict } from './config';
import type { WalkthroughEntry } from './review';

/** `queued` and `processing` are pending; the rest have ended. */
export type ReviewStatus =
	'queued' | 'processing' | 'completed' | 'skipped' | 'failed' | 'superseded';

/** What starts a review. `retry` is a review retried from the Console. */
export type ReviewTriggerKind = 'opened' | 'synchronize' | 'mention' | 'retry';

/** A review of the pull request, as stored. */
export interface ReviewRecord {
	id: string;
	status: ReviewStatus;
	trigger: ReviewTriggerKind;
	/** The head it reviewed, or is reviewing. Empty before it starts. */
	headSha: string;
	summary: string;
	verdict?: Verdict;
	tier?: Tier;
	tierReason: string;
	walkthrough: WalkthroughEntry[];
	/** When it ended, ISO 8601. Absent while pending. */
	completedAt?: string;
}

/**
 * `posted` is open on the pull request; `dropped` was never posted; `resolved` was fixed by a
 * later commit; `dismissed` was settled in a thread or by a maintainer.
 */
export type FindingStatus = 'posted' | 'dropped' | 'resolved' | 'dismissed';

/** A finding of a completed review of the pull request, as stored. */
export interface FindingRecord {
	id: string;
	reviewId: string;
	path: string;
	startLine: number;
	endLine: number;
	severity: Severity;
	category: string;
	title: string;
	body: string;
	suggestion: string | null;
	status: FindingStatus;
	dropReason: string | null;
	/** The GitHub comment it was posted as: the root of its thread. Null when it has none. */
	providerCommentId: number | null;
	/** ISO 8601. */
	createdAt: string;
}

/** A finding the review stores with its outcome. */
export interface FindingOutcome {
	path: string;
	startLine: number;
	endLine: number;
	severity: Severity;
	category: string;
	title: string;
	body: string;
	suggestion: string | null;
	status: 'posted' | 'dropped';
	dropReason: string | null;
	providerCommentId: number | null;
}

/** One model call, for internal cost and usage metering. */
export interface ModelUsage {
	/** `review`, `verify`, `chat`. */
	role: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
	durationMs: number;
}

/** One step of the agent trace, shown live in the Console. */
export interface TraceEvent {
	type: string;
	at: Date;
	data: Record<string, unknown>;
}

export interface ReviewOutcome {
	verdict: Verdict;
	tier: Tier;
	tierReason: string;
	summary: string;
	walkthrough: WalkthroughEntry[];
	findings: FindingOutcome[];
	providerReviewId?: number;
}

/** A review document. Review data lives in the owning project's database, so both are needed. */
export interface ReviewRef {
	projectId: string;
	reviewId: string;
}

/** A pull request of a repository with code review on. */
export interface PullRef {
	projectId: string;
	repositoryId: string;
	pullNumber: number;
}

/** The comment a chat job answered. Chat has no review document, so usage is keyed on this. */
export interface ChatRef extends PullRef {
	commentId: number;
}

export interface ResultsSink {
	/** Every review of the pull request, this one included, newest first by creation. */
	listReviews(pull: PullRef): Promise<ReviewRecord[]>;
	/** The findings of the pull request's completed reviews, oldest first, at most `limit`. */
	listFindings(pull: PullRef, options?: { limit?: number }): Promise<FindingRecord[]>;
	/**
	 * Moves findings to a status. With `from`, only findings still in that status move, so a
	 * finding settled meanwhile is left alone.
	 */
	updateFindings(
		pull: PullRef,
		ids: string[],
		update: { status: FindingStatus; reason: string; from?: FindingStatus }
	): Promise<void>;
	/** Team preferences remembered from conversations, oldest first. */
	listLearnings(repository: { projectId: string; repositoryId: string }): Promise<string[]>;
	createLearning(
		repository: { projectId: string; repositoryId: string },
		learning: { body: string; author: string; sourceUrl: string }
	): Promise<void>;

	/**
	 * The review started working on `headSha` (which may be newer than the queued one). False when
	 * the review already ended, e.g. on a redelivery after it completed: the job stops there.
	 */
	startReview(review: ReviewRef, input: { headSha: string; baseSha: string }): Promise<boolean>;
	/**
	 * Takes stored entries out of `events` as it goes, so after a failure the array holds only
	 * what still needs writing and a second call does not store anything twice.
	 */
	recordEvents(review: ReviewRef, events: TraceEvent[]): Promise<void>;
	/** Takes stored entries out of `usage` as it goes, like `recordEvents`. */
	recordUsage(review: ReviewRef, usage: ModelUsage[]): Promise<void>;
	completeReview(review: ReviewRef, outcome: ReviewOutcome): Promise<void>;
	/** A completed review's grade, after findings settled since it was posted. */
	updateGrade(review: ReviewRef, grade: { tier: Tier; tierReason: string }): Promise<void>;
	/** Nothing to review. `headSha` is the commit it found already covered, when there is one. */
	skipReview(review: ReviewRef, reason: string, headSha?: string): Promise<void>;
	/** `reason` is shown to the project's users; keep internals out of it. */
	failReview(review: ReviewRef, reason: string): Promise<void>;
	/** Model usage of a chat job. Takes stored entries out of `usage` as it goes. */
	recordChatUsage(chat: ChatRef, usage: ModelUsage[]): Promise<void>;
}
