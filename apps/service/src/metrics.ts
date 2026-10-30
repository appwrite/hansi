import type { Attributes, Counter, Histogram, Meter, UpDownCounter } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { ReviewModel, Sandbox, SandboxClient, SandboxResult } from '@hansi/engine';

// Metrics, pushed over OTLP to the cluster's collector as the orchestrator's are. Names are
// already Prometheus names, so they read the same in Grafana whatever the collector appends.
// Labels stay bounded: never a project, repository, pull request or sandbox id.

/** Which part of a job a model call is for. Chat jobs answer with the review model. */
export type ModelRole = 'review' | 'verify' | 'chat';

/** Who an HTTP client talks to. */
export type Peer = 'github' | 'appwrite';

// Reviews take minutes, a repository's setup command up to 15 of them.
const JOB_BUCKETS = [5, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600];
const MODEL_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];
const SANDBOX_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900];
const HTTP_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

export class Metrics {
	private readonly jobs: Counter;
	private readonly jobDuration: Histogram;
	private readonly jobsActive: UpDownCounter;
	private readonly modelCallDuration: Histogram;
	private readonly modelTokens: Counter;
	private readonly sandboxCreateDuration: Histogram;
	private readonly sandboxCommandDuration: Histogram;
	private readonly sandboxesActive: UpDownCounter;
	private readonly sandboxCloses: Counter;
	private readonly httpDuration: Histogram;

	constructor(meter: Meter, options: { concurrency: number }) {
		const seconds = (name: string, description: string, boundaries: number[]) =>
			meter.createHistogram(name, {
				description,
				unit: 's',
				advice: { explicitBucketBoundaries: boundaries }
			});

		this.jobs = meter.createCounter('hansi_jobs_total', {
			description: 'Deliveries run to an outcome, by job type, outcome and whether it is retried'
		});
		this.jobDuration = seconds(
			'hansi_job_duration_seconds',
			'Time from a job starting to its outcome',
			JOB_BUCKETS
		);
		this.jobsActive = meter.createUpDownCounter('hansi_jobs_active', {
			description: 'Jobs running now'
		});
		meter
			.createObservableGauge('hansi_jobs_capacity', {
				description: 'Jobs one process runs at once'
			})
			.addCallback((result) => result.observe(options.concurrency));

		this.modelCallDuration = seconds(
			'hansi_model_call_duration_seconds',
			'One model call, from request to its last token',
			MODEL_BUCKETS
		);
		this.modelTokens = meter.createCounter('hansi_model_tokens_total', {
			description: 'Tokens the provider reports, by type'
		});

		this.sandboxCreateDuration = seconds(
			'hansi_sandbox_create_duration_seconds',
			'Time until a sandbox is ready with the pull request checked out',
			SANDBOX_BUCKETS
		);
		this.sandboxCommandDuration = seconds(
			'hansi_sandbox_command_duration_seconds',
			'One command in a sandbox',
			SANDBOX_BUCKETS
		);
		this.sandboxesActive = meter.createUpDownCounter('hansi_sandboxes_active', {
			description: 'Sandboxes held now'
		});
		this.sandboxCloses = meter.createCounter('hansi_sandbox_closes_total', {
			description: 'Sandbox teardowns, by outcome'
		});

		this.httpDuration = seconds(
			'hansi_http_client_request_duration_seconds',
			'Requests to GitHub and Appwrite, one per attempt',
			HTTP_BUCKETS
		);
	}

	jobStarted(type: string): void {
		this.jobsActive.add(1, { type });
	}

	jobFinished(
		type: string,
		outcome: 'done' | 'failed' | 'invalid',
		retry: boolean,
		seconds?: number
	): void {
		if (outcome !== 'invalid') this.jobsActive.add(-1, { type });
		this.jobs.add(1, { type, outcome, retry: String(retry) });
		if (seconds !== undefined) this.jobDuration.record(seconds, { type, outcome });
	}

	/** The model with every call it makes measured, for one role. */
	instrumentModel(model: ReviewModel, role: ModelRole): ReviewModel {
		const labels = { role, provider: model.provider, model: model.modelId };
		const tokens = (usage: Usage | undefined) => {
			const counts = {
				input: usage?.inputTokens.total,
				output: usage?.outputTokens.total,
				cache_read: usage?.inputTokens.cacheRead,
				cache_write: usage?.inputTokens.cacheWrite,
				reasoning: usage?.outputTokens.reasoning
			};
			for (const [type, count] of Object.entries(counts)) {
				if (count) this.modelTokens.add(count, { ...labels, type });
			}
		};
		const finished = (started: number, attributes: Attributes) =>
			this.modelCallDuration.record(elapsed(started), { ...labels, ...attributes });

		const middleware: LanguageModelMiddleware = {
			specificationVersion: 'v4',
			wrapGenerate: async ({ doGenerate }) => {
				const started = performance.now();
				try {
					const result = await doGenerate();
					finished(started, { outcome: 'ok', finish_reason: result.finishReason.unified });
					tokens(result.usage);
					return result;
				} catch (error) {
					finished(started, { outcome: 'error', finish_reason: '' });
					throw error;
				}
			},
			wrapStream: async ({ doStream }) => {
				const started = performance.now();
				let result: Awaited<ReturnType<typeof doStream>>;
				try {
					result = await doStream();
				} catch (error) {
					finished(started, { outcome: 'error', finish_reason: '' });
					throw error;
				}
				let done = false;
				const stream = result.stream.pipeThrough(
					new TransformStream({
						transform(part, controller) {
							if (part.type === 'finish' && !done) {
								done = true;
								finished(started, { outcome: 'ok', finish_reason: part.finishReason.unified });
								tokens(part.usage);
							} else if (part.type === 'error' && !done) {
								done = true;
								finished(started, { outcome: 'error', finish_reason: '' });
							}
							controller.enqueue(part);
						}
					})
				);
				return { ...result, stream };
			}
		};
		return {
			...model,
			model: wrapLanguageModel({ model: providerModel(model.model), middleware })
		};
	}

	/** The client with every sandbox it creates, and every command run there, measured. */
	instrumentSandboxes(client: SandboxClient): SandboxClient {
		return {
			create: async (spec) => {
				const started = performance.now();
				let sandbox: Sandbox;
				try {
					sandbox = await client.create(spec);
				} catch (error) {
					this.sandboxCreateDuration.record(elapsed(started), { outcome: 'error' });
					throw error;
				}
				this.sandboxCreateDuration.record(elapsed(started), { outcome: 'ok' });
				this.sandboxesActive.add(1);
				return this.instrumentSandbox(sandbox);
			}
		};
	}

	private instrumentSandbox(sandbox: Sandbox): Sandbox {
		let closed: Promise<void> | undefined;
		return {
			id: sandbox.id,
			run: async (command, options) => {
				const started = performance.now();
				let result: SandboxResult;
				try {
					result = await sandbox.run(command, options);
				} catch (error) {
					this.sandboxCommandDuration.record(elapsed(started), { outcome: 'error' });
					throw error;
				}
				this.sandboxCommandDuration.record(elapsed(started), { outcome: commandOutcome(result) });
				return result;
			},
			close: () => {
				// Counted once, however often the engine closes it.
				closed ??= sandbox.close().then(
					() => {
						this.sandboxesActive.add(-1);
						this.sandboxCloses.add(1, { outcome: 'ok' });
					},
					(error: unknown) => {
						this.sandboxesActive.add(-1);
						this.sandboxCloses.add(1, { outcome: 'error' });
						throw error;
					}
				);
				return closed;
			}
		};
	}

	/** `fetch`, with each request measured by peer, method and status. */
	instrumentFetch(peer: Peer, http: typeof fetch = fetch): typeof fetch {
		const measured = async (...[input, init]: Parameters<typeof fetch>) => {
			const method = (
				init?.method ?? (input instanceof Request ? input.method : 'GET')
			).toUpperCase();
			const started = performance.now();
			try {
				const response = await http(input, init);
				this.httpDuration.record(elapsed(started), {
					peer,
					method,
					status: String(response.status)
				});
				return response;
			} catch (error) {
				this.httpDuration.record(elapsed(started), { peer, method, status: 'error' });
				throw error;
			}
		};
		return Object.assign(measured, { preconnect: http.preconnect });
	}
}

/** Starts exporting when an OTLP endpoint is set. Without one, every instrument does nothing. */
export function startMetrics(
	env: { OTEL_EXPORTER_OTLP_ENDPOINT?: string },
	options: { concurrency: number }
): { metrics: Metrics; shutdown(): Promise<void> } {
	if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		const provider = new MeterProvider();
		return { metrics: new Metrics(provider.getMeter('hansi'), options), shutdown: async () => {} };
	}
	// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (the pod's identity) override these.
	const resource = resourceFromAttributes({ 'service.name': 'hansi' }).merge(
		detectResources({ detectors: [envDetector] })
	);
	const provider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				// Reads OTEL_EXPORTER_OTLP_ENDPOINT and its siblings itself.
				exporter: new OTLPMetricExporter(),
				exportIntervalMillis: 60_000
			})
		]
	});
	return {
		metrics: new Metrics(provider.getMeter('hansi'), options),
		// Flushes what the last interval collected, so a rollout does not drop it.
		shutdown: () => provider.shutdown()
	};
}

type Usage = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>>['usage'];

/** Models are always provider instances here: `createReviewModel` never names one by string. */
function providerModel(
	model: ReviewModel['model']
): Parameters<typeof wrapLanguageModel>[0]['model'] {
	if (typeof model === 'string') throw new Error(`model ${model} is not a provider instance`);
	return model;
}

function commandOutcome(result: SandboxResult): string {
	if (result.timedOut) return 'timeout';
	return result.exitCode === 0 ? 'ok' : 'exit_nonzero';
}

function elapsed(started: number): number {
	return (performance.now() - started) / 1000;
}
