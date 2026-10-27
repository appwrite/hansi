import { describe, expect, test } from 'bun:test';
import { NotImplementedError, type ChatJob, type Job, type ReviewJob } from '@hansi/engine';
import { MemoryResultsSink } from '@hansi/engine/testing';
import type { Handlers } from './handlers';
import { createLogger } from './logger';
import { FAILURE_REASON, Worker, type Delivery } from './worker';

const repository = {
	projectId: 'project1',
	projectInternalId: '1',
	repositoryId: 'repo1',
	installationId: 'installation1',
	providerInstallationId: '2',
	providerRepositoryId: '3',
	owner: 'appwrite',
	name: 'appwrite'
};

const review: ReviewJob = {
	type: 'review',
	reviewId: 'review1',
	repository,
	pullNumber: 1,
	headSha: 'a'.repeat(40),
	trigger: { kind: 'opened' }
};

const chat: ChatJob = {
	type: 'chat',
	repository,
	pullNumber: 1,
	comment: {
		id: 5,
		kind: 'issue',
		author: 'octocat',
		authorAssociation: 'MEMBER',
		url: 'https://github.com/x'
	}
};

const silent = createLogger('error', {}, () => {});

const first = (job: unknown): Delivery => ({ payload: job, attempts: 0, maxAttempts: 3 });
const last = (job: unknown): Delivery => ({ payload: job, attempts: 2, maxAttempts: 3 });

const failing = (error: unknown): Handlers => ({
	review: () => Promise.reject(error),
	chat: () => Promise.reject(error)
});

function worker(handlers: Handlers, sink = new MemoryResultsSink(), concurrency = 2) {
	return { worker: new Worker({ sink, handlers, logger: silent, concurrency }), sink };
}

describe('Worker', () => {
	test('dispatches each job to its handler', async () => {
		const seen: Job[] = [];
		const { worker: w } = worker({
			review: async (job) => void seen.push(job),
			chat: async (job) => void seen.push(job)
		});

		expect(await w.run(first(review))).toEqual({ outcome: 'done' });
		expect(await w.run(first(chat))).toEqual({ outcome: 'done' });
		expect(seen).toEqual([review, chat]);
	});

	test('refuses a payload no delivery can run', async () => {
		const { worker: w } = worker({ review: async () => {}, chat: async () => {} });

		const outcome = await w.run(first({ type: 'review', reviewId: 'review1' }));

		expect(outcome?.outcome).toBe('invalid');
	});

	test('retries a failed job while it has attempts left', async () => {
		const { worker: w, sink } = worker(failing(new Error('rate limited')));

		expect(await w.run(first(review))).toEqual({ outcome: 'failed', retry: true });
		expect(sink.calls).toEqual([]);
	});

	test('marks a review failed on its last attempt', async () => {
		const { worker: w, sink } = worker(failing(new Error('boom')));

		expect(await w.run(last(review))).toEqual({ outcome: 'failed', retry: false });
		expect(sink.calls).toEqual([
			{
				method: 'failReview',
				review: { projectId: 'project1', reviewId: 'review1' },
				reason: FAILURE_REASON
			}
		]);
	});

	test('treats a rejection without a reason as a failure', async () => {
		const { worker: w } = worker(failing(undefined));

		expect(await w.run(first(review))).toEqual({ outcome: 'failed', retry: true });
	});

	test('does not retry what is not implemented', async () => {
		const { worker: w, sink } = worker(failing(new NotImplementedError('review engine')));

		expect(await w.run(first(review))).toEqual({ outcome: 'failed', retry: false });
		expect(sink.calls.map((c) => c.method)).toEqual(['failReview']);
	});

	test('retries a review whose failure could not be recorded, past its attempts', async () => {
		const sink = new MemoryResultsSink();
		sink.failReview = async () => {
			throw new Error('appwrite unavailable');
		};
		const { worker: w } = worker(failing(new Error('boom')), sink);

		expect(await w.run(last(review))).toEqual({ outcome: 'failed', retry: true });
	});

	test('takes no more jobs than it has slots, and drains', async () => {
		const release = Promise.withResolvers<void>();
		const { worker: w } = worker(
			{ review: () => release.promise, chat: async () => {} },
			undefined,
			1
		);

		const running = w.run(first(review));
		expect(w.available).toBe(false);
		expect(await w.run(first(chat))).toBeNull();

		let drained = false;
		const draining = w.drained().then(() => (drained = true));
		await Bun.sleep(1);
		expect(drained).toBe(false);

		release.resolve();
		expect(await running).toEqual({ outcome: 'done' });
		await draining;
		expect(w.available).toBe(true);
	});

	test('tells running jobs to stop on abort', async () => {
		const { worker: w } = worker({
			review: (_job, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(new Error('aborted')))
				),
			chat: async () => {}
		});

		const running = w.run(first(review));
		w.abort();

		expect(await running).toEqual({ outcome: 'failed', retry: true });
	});
});
