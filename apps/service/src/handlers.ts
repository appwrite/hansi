import {
	runChatJob,
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

export function createHandlers(context: EngineContext, models: Models): Handlers {
	return {
		review: (job, signal) => runReviewJob(job, context, { ...models, signal }),
		chat: (job, signal) => runChatJob(job, context, { model: models.reviewer, signal })
	};
}
