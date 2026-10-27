// In-memory adapters for tests. Not for production: nothing here survives a restart.

import type { Job } from './jobs';
import type { JobSource, Lease } from './job-source';
import type { ModelUsage, ResultsSink, ReviewOutcome, ReviewRef, TraceEvent } from './results';

export type Settlement = { job: Job; result: 'ack' } | { job: Job; result: 'nack'; retry: boolean };

export class MemoryJobSource implements JobSource {
	readonly settled: Settlement[] = [];
	private readonly pending: Job[] = [];
	private readonly waiters: Array<(job: Job) => void> = [];

	push(...jobs: Job[]): void {
		for (const job of jobs) {
			const waiter = this.waiters.shift();
			if (waiter) waiter(job);
			else this.pending.push(job);
		}
	}

	async next(signal: AbortSignal): Promise<Lease | null> {
		if (signal.aborted) return null;
		const queued = this.pending.shift();
		if (queued) return this.lease(queued);

		return new Promise((resolve) => {
			const waiter = (job: Job) => {
				signal.removeEventListener('abort', onAbort);
				resolve(this.lease(job));
			};
			const onAbort = () => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				resolve(null);
			};
			this.waiters.push(waiter);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private lease(job: Job): Lease {
		return {
			job,
			attempts: 0,
			ack: async () => {
				this.settled.push({ job, result: 'ack' });
			},
			nack: async ({ retry }) => {
				this.settled.push({ job, result: 'nack', retry });
			}
		};
	}
}

export type SinkCall =
	| { method: 'startReview'; review: ReviewRef; headSha: string; baseSha: string }
	| { method: 'recordEvents'; review: ReviewRef; events: TraceEvent[] }
	| { method: 'recordUsage'; review: ReviewRef; usage: ModelUsage[] }
	| { method: 'completeReview'; review: ReviewRef; outcome: ReviewOutcome }
	| { method: 'skipReview'; review: ReviewRef; reason: string }
	| { method: 'failReview'; review: ReviewRef; reason: string };

export class MemoryResultsSink implements ResultsSink {
	readonly calls: SinkCall[] = [];

	async startReview(review: ReviewRef, input: { headSha: string; baseSha: string }) {
		this.calls.push({ method: 'startReview', review, ...input });
	}

	async recordEvents(review: ReviewRef, events: TraceEvent[]) {
		this.calls.push({ method: 'recordEvents', review, events });
	}

	async recordUsage(review: ReviewRef, usage: ModelUsage[]) {
		this.calls.push({ method: 'recordUsage', review, usage });
	}

	async completeReview(review: ReviewRef, outcome: ReviewOutcome) {
		this.calls.push({ method: 'completeReview', review, outcome });
	}

	async skipReview(review: ReviewRef, reason: string) {
		this.calls.push({ method: 'skipReview', review, reason });
	}

	async failReview(review: ReviewRef, reason: string) {
		this.calls.push({ method: 'failReview', review, reason });
	}
}
