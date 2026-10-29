import type {
	ChatRef,
	FindingRecord,
	FindingStatus,
	ModelUsage,
	PullRef,
	ResultsSink,
	ReviewOutcome,
	ReviewRecord,
	ReviewRef,
	Tier,
	TraceEvent
} from '@hansi/engine';
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

	async listReviews(pull: PullRef): Promise<ReviewRecord[]> {
		const { reviews } = await this.api.request<{ reviews: ReviewRecord[] }>(
			'GET',
			`${pullPath(pull)}/reviews`,
			{ projectId: pull.projectId }
		);
		return reviews;
	}

	async listFindings(pull: PullRef, options: { limit?: number } = {}): Promise<FindingRecord[]> {
		const { findings } = await this.api.request<{ findings: FindingRecord[] }>(
			'GET',
			`${pullPath(pull)}/findings`,
			{ projectId: pull.projectId, limit: options.limit }
		);
		return findings;
	}

	async updateFindings(
		pull: PullRef,
		ids: string[],
		update: { status: FindingStatus; reason: string; from?: FindingStatus }
	) {
		if (ids.length === 0) return;
		await this.api.request('PATCH', `${pullPath(pull)}/findings/status`, {
			projectId: pull.projectId,
			findingIds: ids,
			...update
		});
	}

	async listLearnings(repository: { projectId: string; repositoryId: string }) {
		const { learnings } = await this.api.request<{ learnings: string[] }>(
			'GET',
			`${repositoryPath(repository)}/learnings`,
			{ projectId: repository.projectId }
		);
		return learnings;
	}

	async createLearning(
		repository: { projectId: string; repositoryId: string },
		learning: { body: string; author: string; sourceUrl: string }
	) {
		await this.api.request('POST', `${repositoryPath(repository)}/learnings`, {
			projectId: repository.projectId,
			...learning
		});
	}

	async updateGrade(review: ReviewRef, grade: { tier: Tier; tierReason: string }) {
		await this.api.request('PATCH', `${path(review)}/tier`, {
			projectId: review.projectId,
			...grade
		});
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

	async recordChatUsage(chat: ChatRef, usage: ModelUsage[]) {
		while (usage.length) {
			await this.api.request('POST', `${repositoryPath(chat)}/usage`, {
				projectId: chat.projectId,
				pullNumber: chat.pullNumber,
				commentId: chat.commentId,
				usage: usage.slice(0, BATCH)
			});
			usage.splice(0, BATCH);
		}
	}

	async completeReview(review: ReviewRef, outcome: ReviewOutcome) {
		await this.status(review, { status: 'completed', ...outcome });
	}

	async skipReview(review: ReviewRef, reason: string, headSha?: string) {
		await this.status(review, { status: 'skipped', reason, ...(headSha ? { headSha } : {}) });
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

function repositoryPath(repository: { repositoryId: string }): string {
	return `/reviews/repositories/${encodeURIComponent(repository.repositoryId)}`;
}

function pullPath(pull: PullRef): string {
	return `${repositoryPath(pull)}/pulls/${pull.pullNumber}`;
}
