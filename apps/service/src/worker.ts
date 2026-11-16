import { InvalidJobError, parseJob } from '@hansi/appwrite';
import { NotImplementedError, type Job, type ResultsSink } from '@hansi/engine';
import type { Handlers } from './handlers';
import type { Logger } from './logger';
import type { Metrics } from './metrics';
import { DEFAULT_REGION } from './regions';

// Runs the jobs the queue consumer hands over. The consumer owns the queue: it receives, keeps
// the delivery alive and settles it by the outcome this returns. What a failure means for the
// review, and whether another delivery is worth it, is decided here.

/** What the project's users see when a review fails. The cause stays in the logs. */
export const FAILURE_REASON = 'The review could not be completed.';

/** A failed answer is tried once more, as on hansi.codes: a question gets a reply, not a backlog. */
export const CHAT_MAX_ATTEMPTS = 2;

/** One delivery of a message on the reviews queue. */
export interface Delivery {
	payload: unknown;
	/** How many times the message was delivered before, 0 on the first delivery. */
	attempts: number;
	/** Deliveries the queue allows. The last one is not retried. */
	maxAttempts: number;
}

/** What jobs from one region run with: results and GitHub tokens come from its own Appwrite. */
export interface RegionJobs {
	sink: ResultsSink;
	handlers: Handlers;
}

export type Outcome =
	/** The job is done, whatever its outcome on GitHub. */
	| { outcome: 'done' }
	/**
	 * The job failed. With `retry`, it should be delivered again, with fresh attempts once it is
	 * out of them. Without, it belongs with the queue's dead letters.
	 */
	| { outcome: 'failed'; retry: boolean }
	/** No delivery of this payload can succeed. */
	| { outcome: 'invalid'; reason: string };

export interface WorkerOptions {
	/**
	 * By the region a job names (`repository.region`). `DEFAULT_REGION` runs every job, whatever
	 * region it names: a process with one Appwrite.
	 */
	regions: ReadonlyMap<string, RegionJobs>;
	logger: Logger;
	/** Jobs that run at once, from every region together. */
	concurrency: number;
	metrics?: Metrics;
}

export class Worker {
	private running = 0;
	private readonly idle: Array<() => void> = [];
	/** Aborted when the process stops without waiting: the engine cleans up what it holds. */
	private readonly stopping = new AbortController();

	constructor(private readonly options: WorkerOptions) {}

	/** Whether another job would start now. */
	get available(): boolean {
		return this.running < this.options.concurrency;
	}

	/** Runs one delivery to its outcome. Null when every slot is taken and nothing started. */
	async run(delivery: Delivery): Promise<Outcome | null> {
		if (!this.available) return null;
		let job: Job;
		try {
			job = parseJob(delivery.payload);
		} catch (error) {
			if (!(error instanceof InvalidJobError)) throw error;
			this.options.logger.error('invalid job', { attempt: delivery.attempts + 1, err: error });
			this.options.metrics?.jobFinished('unknown', 'invalid', false);
			return { outcome: 'invalid', reason: error.message };
		}
		const { regions } = this.options;
		const region =
			regions.get(job.repository.region ?? DEFAULT_REGION) ?? regions.get(DEFAULT_REGION);
		if (!region) {
			// Its results have nowhere to go from here; the dead letters keep it for a fixed config.
			const reason = `No Appwrite for region ${job.repository.region ?? DEFAULT_REGION}`;
			this.options.logger.error('invalid job', { attempt: delivery.attempts + 1, reason });
			this.options.metrics?.jobFinished(job.type, 'invalid', false);
			return { outcome: 'invalid', reason };
		}

		this.running++;
		this.options.metrics?.jobStarted(job.type);
		const started = performance.now();
		let outcome: Outcome | undefined;
		try {
			outcome = await this.runJob(job, delivery, region);
			return outcome;
		} finally {
			// No outcome: the process stopped under the job, and its delivery goes back unsettled.
			this.options.metrics?.jobFinished(
				job.type,
				outcome?.outcome ?? 'failed',
				outcome === undefined || (outcome.outcome === 'failed' && outcome.retry),
				(performance.now() - started) / 1000
			);
			this.running--;
			if (this.running === 0) this.idle.splice(0).forEach((resolve) => resolve());
		}
	}

	/** Resolves once no job is running. */
	drained(): Promise<void> {
		if (this.running === 0) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	/** Tells running jobs to stop. Their deliveries go back to the queue unsettled. */
	abort(): void {
		this.stopping.abort();
	}

	private async runJob(job: Job, delivery: Delivery, region: RegionJobs): Promise<Outcome> {
		const { handlers, sink } = region;
		const logger = this.options.logger.child({
			...(job.repository.region ? { region: job.repository.region } : {}),
			job: job.type,
			project: job.repository.projectId,
			repository: `${job.repository.owner}/${job.repository.name}`,
			pull: job.pullNumber,
			...(job.type === 'review' ? { review: job.reviewId } : {})
		});
		const { signal } = this.stopping;
		const attempt = {
			attempts: delivery.attempts + 1,
			maxAttempts:
				job.type === 'chat'
					? Math.min(delivery.maxAttempts, CHAT_MAX_ATTEMPTS)
					: delivery.maxAttempts
		};

		let failure: unknown;
		try {
			const run = { attempt, log: logger, signal };
			if (job.type === 'review') await handlers.review(job, run);
			else await handlers.chat(job, run);
			logger.info('job done');
			return { outcome: 'done' };
		} catch (error) {
			failure = error;
		}

		let retry = !(failure instanceof NotImplementedError) && attempt.attempts < attempt.maxAttempts;
		logger.error('job failed', { err: failure, attempt: attempt.attempts, retry });
		if (!retry && job.type === 'review') {
			try {
				await sink.failReview(
					{ projectId: job.repository.projectId, reviewId: job.reviewId },
					FAILURE_REASON
				);
			} catch (sinkError) {
				// Kept for another delivery to mark it, past the queue's attempts if need be. While
				// Appwrite is down that delivery fails early, before any model call.
				logger.error('could not mark review failed', { err: sinkError });
				retry = true;
			}
		}
		return { outcome: 'failed', retry };
	}
}
