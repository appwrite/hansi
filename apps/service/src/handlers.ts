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

export function createHandlers(context: Omit<EngineContext, 'log'>): Handlers {
	return {
		review: (job, { attempt, log, signal }) =>
			runReviewJob(job, { ...context, log }, attempt, signal),
		chat: (job, { attempt, log, signal }) => runChatJob(job, { ...context, log }, attempt, signal)
	};
}
