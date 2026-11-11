import {
	runChatJob,
	runReviewJob,
	type Attempt,
	type ChatJob,
	type EngineContext,
	type Log,
	type ReviewJob,
	type Strength
} from '@hansi/engine';

/** One delivery's run: which attempt it is, the job's own logger, and when to stop. */
export interface Run {
	attempt: Attempt;
	log: Log;
	signal: AbortSignal;
}

export interface Handlers {
	review(job: ReviewJob, run: Run): Promise<void>;
	chat(job: ChatJob, run: Run): Promise<void>;
}

type Context = Omit<EngineContext, 'log'>;

/**
 * A review runs with the context of the strength Appwrite queued it at; chat jobs take their own,
 * e.g. models measured apart from reviews.
 */
export function createHandlers(
	reviews: Record<Strength, Context>,
	chat: Context = reviews.normal
): Handlers {
	return {
		review: (job, { attempt, log, signal }) =>
			runReviewJob(job, { ...reviews[job.strength], log }, attempt, signal),
		chat: (job, { attempt, log, signal }) => runChatJob(job, { ...chat, log }, attempt, signal)
	};
}
