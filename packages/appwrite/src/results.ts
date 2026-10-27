import {
	NotImplementedError,
	type ModelUsage,
	type ResultsSink,
	type ReviewOutcome,
	type TraceEvent
} from '@hansi/engine';
import type { AppwriteConfig } from './config';

/**
 * Writes review results through Appwrite's internal API into the project's review
 * collections, where the Console reads them and Realtime streams progress.
 */
export class AppwriteResultsSink implements ResultsSink {
	constructor(readonly config: AppwriteConfig) {}

	async startReview(_reviewId: string, _input: { headSha: string; baseSha: string }) {
		throw new NotImplementedError('AppwriteResultsSink.startReview');
	}

	async recordEvents(_reviewId: string, _events: TraceEvent[]) {
		throw new NotImplementedError('AppwriteResultsSink.recordEvents');
	}

	async recordUsage(_reviewId: string, _usage: ModelUsage[]) {
		throw new NotImplementedError('AppwriteResultsSink.recordUsage');
	}

	async completeReview(_reviewId: string, _outcome: ReviewOutcome) {
		throw new NotImplementedError('AppwriteResultsSink.completeReview');
	}

	async skipReview(_reviewId: string, _reason: string) {
		throw new NotImplementedError('AppwriteResultsSink.skipReview');
	}

	async failReview(_reviewId: string, _reason: string) {
		throw new NotImplementedError('AppwriteResultsSink.failReview');
	}
}
