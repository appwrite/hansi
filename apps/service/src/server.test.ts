import { afterEach, describe, expect, test } from 'bun:test';
import type { ReviewJob } from '@hansi/engine';
import { MemoryResultsSink } from '@hansi/engine/testing';
import { createLogger } from './logger';
import { startJobsServer } from './server';
import { Worker } from './worker';

const review: ReviewJob = {
	type: 'review',
	reviewId: 'review1',
	repository: {
		projectId: 'project1',
		projectInternalId: '1',
		repositoryId: 'repo1',
		installationId: 'installation1',
		providerInstallationId: '2',
		providerRepositoryId: '3',
		owner: 'appwrite',
		name: 'appwrite'
	},
	pullNumber: 1,
	headSha: 'a'.repeat(40),
	trigger: { kind: 'opened' }
};

let servers: Array<ReturnType<typeof startJobsServer>> = [];
afterEach(async () => {
	await Promise.all(servers.map((server) => server.stop(true)));
	servers = [];
});

function serve(options: { review?: () => Promise<void> } = {}) {
	const worker = new Worker({
		sink: new MemoryResultsSink(),
		handlers: { review: options.review ?? (async () => {}), chat: async () => {} },
		logger: createLogger('error', {}, () => {}),
		concurrency: 1
	});
	const server = startJobsServer({ port: 0, worker });
	servers.push(server);
	const post = (body: unknown) =>
		fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	return { server, post };
}

describe('startJobsServer', () => {
	test('answers with the outcome once the job is done', async () => {
		const { post } = serve();

		const response = await post({ payload: review, attempts: 0, maxAttempts: 3 });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ outcome: 'done' });
	});

	test('listens on loopback only', () => {
		const { server } = serve();

		expect(server.hostname).toBe('127.0.0.1');
	});

	test('refuses a request that is not a delivery', async () => {
		const { post } = serve();

		expect((await post({ payload: review })).status).toBe(400);
		expect((await post({ payload: review, attempts: -1, maxAttempts: 3 })).status).toBe(400);
	});

	test('is busy while every slot runs a job', async () => {
		const release = Promise.withResolvers<void>();
		const { post } = serve({ review: () => release.promise });

		const running = post({ payload: review, attempts: 0, maxAttempts: 3 });
		await Bun.sleep(10);
		const busy = await post({ payload: review, attempts: 0, maxAttempts: 3 });

		expect(busy.status).toBe(503);
		expect(await busy.json()).toEqual({ outcome: 'busy' });
		release.resolve();
		expect(await (await running).json()).toEqual({ outcome: 'done' });
	});
});
