import type { Job } from './jobs';

/**
 * One job handed to this worker. Until it is settled with `ack` or `nack`, no other worker
 * receives it; a worker that dies without settling lets the job be delivered again.
 */
export interface Lease {
	job: Job;
	/** How many times the job was delivered before, 0 on the first delivery. */
	attempts: number;
	/** Deliveries the queue allows. The last one is not retried. */
	maxAttempts: number;
	/** The job is done, whatever its outcome on GitHub. */
	ack(): Promise<void>;
	/**
	 * The job failed. With `retry` and attempts left, it is delivered again later. Otherwise the
	 * queue keeps it with its dead letters, which only an operator re-drives.
	 */
	nack(options: { retry: boolean }): Promise<void>;
}

/** Where jobs come from. In production that is the Appwrite queue. */
export interface JobSource {
	/**
	 * Waits for the next job. Resolves `null` once `signal` aborts, so a worker stops taking
	 * work on shutdown and finishes what it holds.
	 */
	next(signal: AbortSignal): Promise<Lease | null>;
}
