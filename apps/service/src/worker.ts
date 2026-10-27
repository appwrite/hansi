import { NotImplementedError, type JobSource, type Lease, type ResultsSink } from '@hansi/engine';
import type { Handlers } from './handlers';
import type { Logger } from './logger';

/** Deliveries of one job before it is given up on. */
export const MAX_ATTEMPTS = 3;
/** What the project's users see when a review fails. The cause stays in the logs. */
export const FAILURE_REASON = 'The review could not be completed.';

export interface WorkerOptions {
	source: JobSource;
	sink: ResultsSink;
	handlers: Handlers;
	logger: Logger;
	concurrency: number;
	/** Aborting stops taking jobs; jobs already running finish. */
	signal: AbortSignal;
}

/** Runs jobs until `signal` aborts and every running job settled. */
export async function runWorker(options: WorkerOptions): Promise<void> {
	const slots = Array.from({ length: options.concurrency }, (_, slot) => runSlot(options, slot));
	await Promise.all(slots);
}

async function runSlot(options: WorkerOptions, slot: number): Promise<void> {
	const { source, logger, signal } = options;
	while (!signal.aborted) {
		let lease: Lease | null;
		try {
			lease = await source.next(signal);
		} catch (error) {
			if (error instanceof NotImplementedError) throw error;
			logger.error('job source failed', { slot, err: error });
			await Bun.sleep(1_000);
			continue;
		}
		if (!lease) return;
		await runJob(options, lease);
	}
}

async function runJob(options: WorkerOptions, lease: Lease): Promise<void> {
	const { job } = lease;
	const logger = options.logger.child({
		job: job.type,
		project: job.repository.projectId,
		repository: `${job.repository.owner}/${job.repository.name}`,
		pull: job.pullNumber,
		...(job.type === 'review' ? { review: job.reviewId } : {})
	});
	// A running job is not cut short on shutdown; the signal is for the engine's own cleanup.
	const running = new AbortController();

	try {
		if (job.type === 'review') await options.handlers.review(job, running.signal);
		else await options.handlers.chat(job, running.signal);
		await lease.ack();
		logger.info('job done');
	} catch (error) {
		const retry = !(error instanceof NotImplementedError) && lease.attempts + 1 < MAX_ATTEMPTS;
		logger.error('job failed', { err: error, attempt: lease.attempts + 1, retry });
		if (!retry && job.type === 'review') {
			await options.sink
				.failReview(job.reviewId, FAILURE_REASON)
				.catch((sinkError: unknown) =>
					logger.error('could not mark review failed', { err: sinkError })
				);
		}
		await lease
			.nack({ retry })
			.catch((nackError: unknown) => logger.error('could not settle job', { err: nackError }));
	}
}
