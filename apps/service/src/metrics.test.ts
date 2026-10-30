import { describe, expect, test } from 'bun:test';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { MemoryResultsSink, MemorySandboxes } from '@hansi/engine/testing';
import { createLogger } from './logger';
import { Metrics } from './metrics';
import { Worker } from './worker';

class Reader extends MetricReader {
	protected async onForceFlush() {}
	protected async onShutdown() {}

	/** Every point of one metric, by its attributes. */
	async points(name: string): Promise<DataPoint<unknown>[]> {
		const { resourceMetrics } = await this.collect();
		const metric = resourceMetrics.scopeMetrics
			.flatMap((scope) => scope.metrics)
			.find((metric) => metric.descriptor.name === name);
		return (metric?.dataPoints ?? []) as DataPoint<unknown>[];
	}
}

function setup() {
	const reader = new Reader();
	const provider = new MeterProvider({ readers: [reader] });
	return { reader, metrics: new Metrics(provider.getMeter('test'), { concurrency: 4 }) };
}

const silent = createLogger('error', {}, () => {});

const usage = {
	inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined },
	outputTokens: { total: 30, text: 20, reasoning: 10 }
};

describe('Metrics', () => {
	test('counts jobs by type and outcome, and how many run', async () => {
		const { reader, metrics } = setup();
		const worker = new Worker({
			sink: new MemoryResultsSink(),
			handlers: { review: async () => {}, chat: () => Promise.reject(new Error('down')) },
			logger: silent,
			concurrency: 4,
			metrics
		});
		const repository = {
			projectId: 'p',
			projectInternalId: '1',
			repositoryId: 'r',
			installationId: 'i',
			providerInstallationId: '2',
			providerRepositoryId: '3',
			owner: 'appwrite',
			name: 'appwrite'
		};

		await worker.run({
			payload: {
				type: 'review',
				reviewId: 'review1',
				repository,
				pullNumber: 1,
				headSha: 'a'.repeat(40),
				trigger: { kind: 'opened' }
			},
			attempts: 0,
			maxAttempts: 3
		});
		await worker.run({
			payload: {
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
			},
			attempts: 0,
			maxAttempts: 3
		});
		await worker.run({ payload: { type: 'review' }, attempts: 0, maxAttempts: 3 });

		const jobs = (await reader.points('hansi_jobs_total')).map((p) => [p.attributes, p.value]);
		expect(jobs).toEqual([
			[{ type: 'review', outcome: 'done', retry: 'false' }, 1],
			[{ type: 'chat', outcome: 'failed', retry: 'true' }, 1],
			[{ type: 'unknown', outcome: 'invalid', retry: 'false' }, 1]
		]);
		const active = await reader.points('hansi_jobs_active');
		expect(active.map((p) => p.value)).toEqual([0, 0]);
		expect((await reader.points('hansi_jobs_capacity'))[0]?.value).toBe(4);
	});

	test('measures model calls and the tokens they used', async () => {
		const { reader, metrics } = setup();
		const model = metrics.instrumentModel(
			{
				model: new MockLanguageModelV4({
					doGenerate: {
						content: [{ type: 'text', text: 'ok' }],
						finishReason: { unified: 'stop', raw: 'end_turn' },
						usage,
						warnings: []
					}
				}),
				provider: 'amazon-bedrock',
				modelId: 'luna'
			},
			'verify'
		);

		await generateText({ model: model.model, prompt: 'hi' });

		const labels = { role: 'verify', provider: 'amazon-bedrock', model: 'luna' };
		const calls = await reader.points('hansi_model_call_duration_seconds');
		expect(calls.map((p) => p.attributes)).toEqual([
			{ ...labels, outcome: 'ok', finish_reason: 'stop' }
		]);
		const tokens = (await reader.points('hansi_model_tokens_total')).map((p) => [
			p.attributes.type,
			p.value
		]);
		expect(tokens).toEqual([
			['input', 120],
			['output', 30],
			['cache_read', 100],
			['reasoning', 10]
		]);
	});

	test('records a failed model call', async () => {
		const { reader, metrics } = setup();
		const model = metrics.instrumentModel(
			{
				model: new MockLanguageModelV4({
					doGenerate: () => Promise.reject(new Error('throttled'))
				}),
				provider: 'amazon-bedrock',
				modelId: 'luna'
			},
			'review'
		);

		await expect(generateText({ model: model.model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(
			'throttled'
		);

		const calls = await reader.points('hansi_model_call_duration_seconds');
		expect(calls.map((p) => p.attributes.outcome)).toEqual(['error']);
	});

	test('measures sandboxes, their commands, and counts a close once', async () => {
		const { reader, metrics } = setup();
		const sandboxes = metrics.instrumentSandboxes(
			new MemorySandboxes((command) => ({
				exitCode: command === 'false' ? 1 : 0,
				stdout: '',
				stderr: '',
				timedOut: command === 'sleep',
				truncated: false
			}))
		);

		const sandbox = await sandboxes.create({ archiveUrl: 'https://github.test/tarball' });
		for (const command of ['true', 'false', 'sleep']) await sandbox.run(command, { timeoutMs: 1 });
		expect((await reader.points('hansi_sandboxes_active'))[0]?.value).toBe(1);
		await sandbox.close();
		await sandbox.close();

		const commands = await reader.points('hansi_sandbox_command_duration_seconds');
		expect(commands.map((p) => p.attributes.outcome)).toEqual(['ok', 'exit_nonzero', 'timeout']);
		const created = await reader.points('hansi_sandbox_create_duration_seconds');
		expect(created.map((p) => p.attributes.outcome)).toEqual(['ok']);
		expect((await reader.points('hansi_sandboxes_active'))[0]?.value).toBe(0);
		expect((await reader.points('hansi_sandbox_closes_total'))[0]?.value).toBe(1);
	});

	test('measures requests by peer, method and status', async () => {
		const { reader, metrics } = setup();
		using server = Bun.serve({
			port: 0,
			fetch: (request) => new Response(null, { status: request.method === 'GET' ? 200 : 404 })
		});
		const http = metrics.instrumentFetch('github');

		await http(server.url);
		await http(server.url, { method: 'post' });
		await expect(http('http://127.0.0.1:1')).rejects.toThrow();

		const requests = await reader.points('hansi_http_client_request_duration_seconds');
		expect(requests.map((p) => p.attributes)).toEqual([
			{ peer: 'github', method: 'GET', status: '200' },
			{ peer: 'github', method: 'POST', status: '404' },
			{ peer: 'github', method: 'GET', status: 'error' }
		]);
	});
});
