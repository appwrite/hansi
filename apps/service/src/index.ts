import {
	AppwriteInstallationTokens,
	AppwriteResultsSink,
	type AppwriteConfig
} from '@hansi/appwrite';
import { clearWorkdir, type Strength } from '@hansi/engine';
import { InstallationGitHubClientFactory } from '@hansi/github';
import { OrchestratorSandboxClient } from '@hansi/sandbox';
import { parseEnv } from './env';
import { createHandlers } from './handlers';
import { createLogger } from './logger';
import { startMetrics } from './metrics';
import { createStrengths, type StrengthConfig } from './models';
import { DEFAULT_REGION } from './regions';
import { startHealthServer, startJobsServer } from './server';
import { Worker, type RegionJobs } from './worker';

const env = parseEnv(process.env);
const logger = createLogger(env.HANSI_LOG_LEVEL, { service: 'hansi' });
const { metrics, shutdown: stopMetrics } = startMetrics(env, {
	concurrency: env.HANSI_CONCURRENCY
});

// Self-hosted Appwrite has no orchestrator: reviews there read the code without running it.
const sandboxes =
	env.HANSI_ORCHESTRATOR_ENDPOINT && env.HANSI_SANDBOX_IMAGE
		? metrics.instrumentSandboxes(
				new OrchestratorSandboxClient({
					endpoint: env.HANSI_ORCHESTRATOR_ENDPOINT,
					apiKey: env.HANSI_ORCHESTRATOR_KEY,
					image: env.HANSI_SANDBOX_IMAGE,
					runtimeClass: env.HANSI_SANDBOX_RUNTIME_CLASS
				})
			)
		: undefined;
// Checkouts a previous run of this process left behind, e.g. after it was killed mid-review.
await clearWorkdir(undefined);
const strengths = createStrengths(env);
const measured = (config: StrengthConfig, strength: Strength) => {
	// Without a verify model the engine verifies with the review model; measured as verification.
	const verify = config.models.verify ?? config.models.review;
	return {
		sandboxes: config.sandboxes ? sandboxes : undefined,
		subagents: config.subagents,
		models: {
			review: metrics.instrumentModel(config.models.review, 'review', strength),
			verify: metrics.instrumentModel(verify, 'verify', strength)
		}
	};
};
const reviews = {
	basic: measured(strengths.basic, 'basic'),
	normal: measured(strengths.normal, 'normal'),
	expert: measured(strengths.expert, 'expert')
};
// Chat jobs answer with the normal models whatever the repository's strength: an answer is
// billed the same at every strength.
const normal = strengths.normal.models;
const chat = {
	sandboxes,
	subagents: false,
	models: {
		review: metrics.instrumentModel(normal.review, 'chat'),
		verify: metrics.instrumentModel(normal.verify ?? normal.review, 'chat')
	}
};

// Models and sandboxes serve every region; results and GitHub tokens come from the job's own.
const regions = new Map(
	env.regions.map((region): [string, RegionJobs] => {
		const appwrite: AppwriteConfig = {
			endpoint: region.endpoint,
			secret: region.secret,
			fetch: metrics.instrumentFetch('appwrite')
		};
		const sink = new AppwriteResultsSink(appwrite);
		const github = new InstallationGitHubClientFactory(new AppwriteInstallationTokens(appwrite), {
			fetch: metrics.instrumentFetch('github')
		});
		const context = { github, results: sink };
		const handlers = createHandlers(
			{
				basic: { ...context, ...reviews.basic },
				normal: { ...context, ...reviews.normal },
				expert: { ...context, ...reviews.expert }
			},
			{ ...context, ...chat }
		);
		return [region.id, { sink, handlers }];
	})
);

const worker = new Worker({
	regions,
	logger,
	concurrency: env.HANSI_CONCURRENCY,
	metrics
});

const jobs = startJobsServer({ port: env.HANSI_JOBS_PORT, worker });
let draining = false;
const server = startHealthServer({ port: env.HANSI_PORT, ready: () => !draining });

// The consumers are children of this process, so the container runs, stops and fails as one.
// They own the queues, one per region; this process owns the jobs, and its slots are shared by
// every region. Started once the jobs port listens.
const command = env.HANSI_CONSUMER_COMMAND?.split(' ').filter(Boolean);
const consumers = command
	? env.regions.map((region) =>
			Bun.spawn(command, {
				// The default region's consumer reads the unsuffixed variables and names no region.
				env:
					region.id === DEFAULT_REGION ? process.env : { ...process.env, HANSI_REGION: region.id },
				stdio: ['ignore', 'inherit', 'inherit']
			})
		)
	: [];
logger.info('service started', {
	port: server.port,
	jobsPort: jobs.port,
	concurrency: env.HANSI_CONCURRENCY,
	regions: env.regions.map((region) => region.id),
	consumers: consumers.length
});

const stopping = Promise.withResolvers<void>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (draining) {
			logger.warn('second signal, exiting without waiting for running jobs', { signal });
			for (const consumer of consumers) consumer.kill('SIGKILL');
			process.exit(1);
		}
		logger.info('shutting down after running jobs finish (signal again to force)', { signal });
		draining = true;
		// The consumers stop receiving, wait for the jobs they handed over and settle them.
		for (const consumer of consumers) consumer.kill('SIGTERM');
		stopping.resolve();
	});
}

if (consumers.length > 0) {
	await Promise.all(
		consumers.map(async (consumer, index) => {
			const region = env.regions[index]?.id;
			const code = await consumer.exited;
			if (!draining) {
				// Its deliveries go back to the queue, so the jobs it handed over stop here too, and
				// the other consumers give theirs back: the container fails as one.
				logger.error('queue consumer exited', { region, code });
				draining = true;
				worker.abort();
				for (const other of consumers) if (other !== consumer) other.kill('SIGTERM');
				process.exitCode = 1;
			} else if (code !== 0) {
				logger.error('queue consumer exited', { region, code });
				process.exitCode = 1;
			}
		})
	);
} else {
	await stopping.promise;
}

await worker.drained();
await jobs.stop();
await server.stop();
await stopMetrics().catch((error: unknown) =>
	logger.warn('could not flush metrics', { err: error })
);
logger.info('service stopped');
process.exit();
