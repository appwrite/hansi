import { NotImplementedError, type JobSource, type Lease } from '@hansi/engine';
import type { AppwriteConfig } from './config';

/**
 * Jobs from the Appwrite reviews queue, published by the Reviews module in appwrite/appwrite
 * (one pending review per pull request, so a burst of pushes queues one review). Each payload
 * goes through `parseJob` before the engine sees it.
 */
export class AppwriteJobSource implements JobSource {
	constructor(readonly config: AppwriteConfig) {}

	async next(signal: AbortSignal): Promise<Lease | null> {
		if (signal.aborted) return null;
		throw new NotImplementedError('AppwriteJobSource.next');
	}
}
