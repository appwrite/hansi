import { describe, expect, test } from 'bun:test';
import {
	NotImplementedError,
	type ChatJob,
	type Job,
	type JobSource,
	type ReviewJob
} from '@hansi/engine';
import { MemoryJobSource, MemoryResultsSink } from '@hansi/engine/testing';
import type { Handlers } from './handlers';
import { createLogger } from './logger';
import { FAILURE_REASON, runWorker } from './worker';

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

/** Runs the worker until `settled` jobs are settled, then shuts it down. */
async function run(
	source: JobSource & { settled: unknown[] },
	handlers: Handlers,
	settled: number
) {
	const sink = new MemoryResultsSink();
	const controller = new AbortController();
	const done = runWorker({
		source,
		sink,
		handlers,
		logger: silent,
		concurrency: 2,
		signal: controller.signal
	});
	while (source.settled.length < settled) await Bun.sleep(1);
	controller.abort();
	await done;
	return sink;
}

describe('runWorker', () => {
	test('dispatches each job to its handler and acks it', async () => {
		const source = new MemoryJobSource();
		const seen: Job[] = [];
		source.push(review, chat);

		await run(
			source,
			{ review: async (job) => void seen.push(job), chat: async (job) => void seen.push(job) },
			2
		);

		expect(seen).toContainAllValues([review, chat]);
		expect(source.settled.map((s) => s.result)).toEqual(['ack', 'ack']);
	});

	test('retries a failed job while it has attempts left', async () => {
		const source = new MemoryJobSource();
		source.push(review);

		const sink = await run(
			source,
			{
				review: async () => {
					throw new Error('rate limited');
				},
				chat: async () => {}
			},
			1
		);

		expect(source.settled).toEqual([{ job: review, result: 'nack', retry: true }]);
		expect(sink.calls).toEqual([]);
	});

	test('marks a review failed on its last attempt', async () => {
		const source: MemoryJobSource = new MemoryJobSource();
		const next = source.next.bind(source);
		source.next = async (signal) => {
			const lease = await next(signal);
			return lease && { ...lease, attempts: lease.maxAttempts - 1 };
		};
		source.push(review);

		const sink = await run(
			source,
			{
				review: async () => {
					throw new Error('boom');
				},
				chat: async () => {}
			},
			1
		);

		expect(source.settled).toEqual([{ job: review, result: 'nack', retry: false }]);
		expect(sink.calls).toEqual([
			{
				method: 'failReview',
				review: { projectId: 'project1', reviewId: 'review1' },
				reason: FAILURE_REASON
			}
		]);
	});

	test('treats a rejection without a reason as a failure', async () => {
		const source = new MemoryJobSource();
		source.push(review);

		await run(
			source,
			{
				review: () => Promise.reject(undefined),
				chat: async () => {}
			},
			1
		);

		expect(source.settled).toEqual([{ job: review, result: 'nack', retry: true }]);
	});

	test('does not retry what is not implemented', async () => {
		const source = new MemoryJobSource();
		source.push(review);

		const sink = await run(
			source,
			{
				review: async () => {
					throw new NotImplementedError('review engine');
				},
				chat: async () => {}
			},
			1
		);

		expect(source.settled).toEqual([{ job: review, result: 'nack', retry: false }]);
		expect(sink.calls.map((c) => c.method)).toEqual(['failReview']);
	});

	test('does not fail a review whose ack failed', async () => {
		const source: MemoryJobSource = new MemoryJobSource();
		const next = source.next.bind(source);
		source.next = async (signal) => {
			const lease = await next(signal);
			return (
				lease && {
					...lease,
					attempts: lease.maxAttempts - 1,
					ack: async () => {
						await lease.ack();
						throw new Error('queue unavailable');
					}
				}
			);
		};
		source.push(review);

		const sink = await run(source, { review: async () => {}, chat: async () => {} }, 1);

		expect(source.settled).toEqual([{ job: review, result: 'ack' }]);
		expect(sink.calls).toEqual([]);
	});

	test('retries a review whose failure could not be recorded', async () => {
		const source = new MemoryJobSource();
		const sink = new MemoryResultsSink();
		sink.failReview = async () => {
			throw new Error('appwrite unavailable');
		};
		const controller = new AbortController();
		source.push(review);

		const done = runWorker({
			source,
			sink,
			handlers: {
				review: async () => {
					throw new NotImplementedError('review engine');
				},
				chat: async () => {}
			},
			logger: silent,
			concurrency: 1,
			signal: controller.signal
		});
		while (source.settled.length < 1) await Bun.sleep(1);
		controller.abort();
		await done;

		expect(source.settled).toEqual([{ job: review, result: 'nack', retry: true }]);
	});

	test('finishes a running job before stopping', async () => {
		const source = new MemoryJobSource();
		const controller = new AbortController();
		let finished = false;
		source.push(review);

		const done = runWorker({
			source,
			sink: new MemoryResultsSink(),
			handlers: {
				review: async () => {
					controller.abort();
					await Bun.sleep(20);
					finished = true;
				},
				chat: async () => {}
			},
			logger: silent,
			concurrency: 1,
			signal: controller.signal
		});
		await done;

		expect(finished).toBe(true);
		expect(source.settled.map((s) => s.result)).toEqual(['ack']);
	});
});
