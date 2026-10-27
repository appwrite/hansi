import {
	NotImplementedError,
	runReviewJob,
	type ChatJob,
	type EngineContext,
	type ReviewJob
} from '@hansi/engine';
import type { LanguageModel } from 'ai';

export interface Handlers {
	review(job: ReviewJob, signal: AbortSignal): Promise<void>;
	chat(job: ChatJob, signal: AbortSignal): Promise<void>;
}

export interface Models {
	reviewer: LanguageModel;
	verifier?: LanguageModel;
}

/** Chat is ported in a follow-up change; until then chat jobs fail permanently. */
export function createHandlers(context: EngineContext, models: Models): Handlers {
	return {
		review: (job, signal) => runReviewJob(job, context, { ...models, signal }),
		async chat() {
			throw new NotImplementedError('chat engine');
		}
	};
}
