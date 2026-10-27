import {
	NotImplementedError,
	type ModelUsage,
	type ResultsSink,
	type ReviewOutcome,
	type ReviewRef,
	type TraceEvent
} from '@hansi/engine';
import type { AppwriteConfig } from './config';

/**
 * Writes review results through Appwrite's internal API into the project's review
 * collections, where the Console reads them and Realtime streams progress.
 */
export class AppwriteResultsSink implements ResultsSink {
	constructor(readonly config: AppwriteConfig) {}

	async startReview(_review: ReviewRef, _input: { headSha: string; baseSha: string }) {
		throw new NotImplementedError('AppwriteResultsSink.startReview');
	}

	async recordEvents(_review: ReviewRef, _events: TraceEvent[]) {
		throw new NotImplementedError('AppwriteResultsSink.recordEvents');
	}

	async recordUsage(_review: ReviewRef, _usage: ModelUsage[]) {
		throw new NotImplementedError('AppwriteResultsSink.recordUsage');
	}

	async completeReview(_review: ReviewRef, _outcome: ReviewOutcome) {
		throw new NotImplementedError('AppwriteResultsSink.completeReview');
	}

	async skipReview(_review: ReviewRef, _reason: string) {
		throw new NotImplementedError('AppwriteResultsSink.skipReview');
	}

	async failReview(_review: ReviewRef, _reason: string) {
		throw new NotImplementedError('AppwriteResultsSink.failReview');
	}
}
