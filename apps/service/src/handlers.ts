import {
	NotImplementedError,
	type ChatJob,
	type EngineContext,
	type ReviewJob
} from '@hansi/engine';

export interface Handlers {
	review(job: ReviewJob, signal: AbortSignal): Promise<void>;
	chat(job: ChatJob, signal: AbortSignal): Promise<void>;
}

/**
 * The review and chat engines are ported in follow-up changes. Until then every job fails
 * permanently: nothing is retried, and every review is marked failed.
 */
export function createHandlers(_context: EngineContext): Handlers {
	return {
		async review() {
			throw new NotImplementedError('review engine');
		},
		async chat() {
			throw new NotImplementedError('chat engine');
		}
	};
}
