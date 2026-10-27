// Where review outcomes go. Appwrite stores them in the project's database and the Console
// reads them from there; GitHub gets its own copy through the GitHubClient.

export type Verdict = 'approve' | 'request_changes' | 'comment';
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
export type Severity = 'critical' | 'major' | 'minor' | 'nit';

export interface Finding {
	path: string;
	startLine?: number;
	line: number;
	severity: Severity;
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

export interface ResultsSink {
	/** The review started working on `headSha` (which may be newer than the queued one). */
	startReview(reviewId: string, input: { headSha: string; baseSha: string }): Promise<void>;
	recordEvents(reviewId: string, events: TraceEvent[]): Promise<void>;
	recordUsage(reviewId: string, usage: ModelUsage[]): Promise<void>;
	completeReview(reviewId: string, outcome: ReviewOutcome): Promise<void>;
	/** Nothing to review: superseded by a newer head, closed, a draft, nothing reviewable. */
	skipReview(reviewId: string, reason: string): Promise<void>;
	/** `reason` is shown to the project's users; keep internals out of it. */
	failReview(reviewId: string, reason: string): Promise<void>;
}
