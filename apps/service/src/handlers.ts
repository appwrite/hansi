import {
	runChatJob,
	runReviewJob,
	type Attempt,
	type ChatJob,
	type EngineContext,
	type Log,
	type ReviewJob
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

/** Chat jobs may take their own context, e.g. models measured apart from reviews. */
export function createHandlers(
	review: Omit<EngineContext, 'log'>,
	chat: Omit<EngineContext, 'log'> = review
): Handlers {
	return {
		review: (job, { attempt, log, signal }) =>
			runReviewJob(job, { ...review, log }, attempt, signal),
		chat: (job, { attempt, log, signal }) => runChatJob(job, { ...chat, log }, attempt, signal)
	};
}
