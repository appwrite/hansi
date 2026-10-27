// Where review outcomes go. Appwrite stores them in the project's database and the Console
// reads them from there; GitHub gets its own copy through the GitHubClient.

import type { Category, Severity, Tier, Verdict } from './grading';

export interface Finding {
	path: string;
	startLine: number;
	endLine: number;
	severity: Severity;
	category: Category;
	title: string;
	body: string;
	/** The inline comment it was posted as, once posted. */
	providerCommentId?: number;
}

/** One model call, for internal cost and usage metering. */
export interface ModelUsage {
	/** `review`, `verify`, `subagent`, `chat`, … */
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
	summary: string;
	findings: Finding[];
	providerReviewId?: number;
}

/** A review document. Review data lives in the owning project's database, so both are needed. */
export interface ReviewRef {
	projectId: string;
	reviewId: string;
}

/** The comment a chat job answered. Chat has no review document, so usage is keyed on this. */
export interface ChatRef {
	projectId: string;
	repositoryId: string;
	pullNumber: number;
	commentId: number;
}

export interface ResultsSink {
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
	/** Nothing to review: superseded by a newer head, closed, a draft, nothing reviewable. */
	skipReview(review: ReviewRef, reason: string): Promise<void>;
	/** `reason` is shown to the project's users; keep internals out of it. */
	failReview(review: ReviewRef, reason: string): Promise<void>;
	/** Model usage of a chat job. Takes stored entries out of `usage` as it goes. */
	recordChatUsage(chat: ChatRef, usage: ModelUsage[]): Promise<void>;
}
