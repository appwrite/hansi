import { NotImplementedError, type JobSource, type Lease, type ResultsSink } from '@hansi/engine';
import type { Handlers } from './handlers';
import type { Logger } from './logger';

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

	let failed = false;
	let failure: unknown;
	try {
		if (job.type === 'review') await options.handlers.review(job, running.signal);
		else await options.handlers.chat(job, running.signal);
	} catch (error) {
		failed = true;
		failure = error;
	}

	if (!failed) {
		// The job is done; an ack that fails only means it may be delivered again.
		await lease.ack().then(
			() => logger.info('job done'),
			(ackError: unknown) => logger.error('could not ack job', { err: ackError })
		);
		return;
	}

	let retry = !(failure instanceof NotImplementedError) && lease.attempts + 1 < lease.maxAttempts;
	logger.error('job failed', { err: failure, attempt: lease.attempts + 1, retry });
	if (!retry && job.type === 'review') {
		try {
			await options.sink.failReview(
				{ projectId: job.repository.projectId, reviewId: job.reviewId },
				FAILURE_REASON
			);
		} catch (sinkError) {
			// Kept for another delivery to mark it. Out of attempts, it waits in the queue's dead
			// letters, where Appwrite's queue retry re-drives it.
			logger.error('could not mark review failed', { err: sinkError });
			retry = true;
		}
	}
	await lease
		.nack({ retry })
		.catch((nackError: unknown) => logger.error('could not settle job', { err: nackError }));
}
