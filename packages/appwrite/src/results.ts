import type { ModelUsage, ResultsSink, ReviewOutcome, ReviewRef, TraceEvent } from '@hansi/engine';
import { AppwriteApi, AppwriteError } from './api';
import type { AppwriteConfig } from './config';

/** Events or usage entries Appwrite takes in one call. */
const BATCH = 100;

/**
 * Writes review results through Appwrite's internal Reviews API into the project's review
 * collections, where the Console reads them and Realtime streams progress.
 */
export class AppwriteResultsSink implements ResultsSink {
	private readonly api: AppwriteApi;

	constructor(config: AppwriteConfig) {
		this.api = new AppwriteApi(config);
	}

	async startReview(review: ReviewRef, input: { headSha: string; baseSha: string }) {
		return this.status(review, { status: 'processing', ...input });
	}

	async recordEvents(review: ReviewRef, events: TraceEvent[]) {
		while (events.length) {
			await this.api.request('POST', `${path(review)}/events`, {
				projectId: review.projectId,
				events: events.slice(0, BATCH).map((event) => ({ ...event, at: event.at.toISOString() }))
			});
			// Stored: a later batch that fails leaves only the rest to send again.
			events.splice(0, BATCH);
		}
	}

	async recordUsage(review: ReviewRef, usage: ModelUsage[]) {
		while (usage.length) {
			await this.api.request('POST', `${path(review)}/usage`, {
				projectId: review.projectId,
				usage: usage.slice(0, BATCH)
			});
			usage.splice(0, BATCH);
		}
	}

	async completeReview(review: ReviewRef, outcome: ReviewOutcome) {
		await this.status(review, { status: 'completed', ...outcome });
	}

	async skipReview(review: ReviewRef, reason: string) {
		await this.status(review, { status: 'skipped', reason });
	}

	async failReview(review: ReviewRef, reason: string) {
		await this.status(review, { status: 'failed', reason });
	}

	/** False when the review already ended, e.g. on a redelivery of a job that finished. */
	private async status(review: ReviewRef, body: Record<string, unknown>): Promise<boolean> {
		try {
			await this.api.request('PATCH', `${path(review)}/status`, {
				projectId: review.projectId,
				...body
			});
			return true;
		} catch (error) {
			if (error instanceof AppwriteError && error.type === 'review_status_invalid') return false;
			throw error;
		}
	}
}

function path(review: ReviewRef): string {
	return `/reviews/${encodeURIComponent(review.reviewId)}`;
}
