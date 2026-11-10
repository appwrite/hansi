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
import { startHealthServer, startJobsServer } from './server';
import { Worker } from './worker';

const env = parseEnv(process.env);
const logger = createLogger(env.HANSI_LOG_LEVEL, { service: 'hansi' });
const { metrics, shutdown: stopMetrics } = startMetrics(env, {
	concurrency: env.HANSI_CONCURRENCY
});

const appwrite: AppwriteConfig = {
	endpoint: env.HANSI_APPWRITE_ENDPOINT,
	secret: env.HANSI_APPWRITE_SECRET,
	fetch: metrics.instrumentFetch('appwrite')
};
const sink = new AppwriteResultsSink(appwrite);
const github = new InstallationGitHubClientFactory(new AppwriteInstallationTokens(appwrite), {
	fetch: metrics.instrumentFetch('github')
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
const context = { github, sandboxes, results: sink };
const measured = (config: StrengthConfig, strength: Strength) => {
	// Without a verify model the engine verifies with the review model; measured as verification.
	const verify = config.models.verify ?? config.models.review;
	return {
		...context,
		sandboxes: config.sandboxes ? sandboxes : undefined,
		subagents: config.subagents,
		models: {
			review: metrics.instrumentModel(config.models.review, 'review', strength),
			verify: metrics.instrumentModel(verify, 'verify', strength)
		}
	};
};
// Chat jobs answer with the normal models whatever the repository's strength: an answer is
// billed the same at every strength.
const normal = strengths.normal.models;
const handlers = createHandlers(
	{
		basic: measured(strengths.basic, 'basic'),
		normal: measured(strengths.normal, 'normal'),
		expert: measured(strengths.expert, 'expert')
	},
	{
		...context,
		subagents: false,
		models: {
			review: metrics.instrumentModel(normal.review, 'chat'),
			verify: metrics.instrumentModel(normal.verify ?? normal.review, 'chat')
		}
	}
);

const worker = new Worker({
	sink,
	handlers,
	logger,
	concurrency: env.HANSI_CONCURRENCY,
	metrics
});

const jobs = startJobsServer({ port: env.HANSI_JOBS_PORT, worker });
let draining = false;
const server = startHealthServer({ port: env.HANSI_PORT, ready: () => !draining });

// The consumer is a child of this process, so the container runs, stops and fails as one.
// It owns the queue; this process owns the jobs. Started once the jobs port listens.
const consumer = env.HANSI_CONSUMER_COMMAND
	? Bun.spawn(env.HANSI_CONSUMER_COMMAND.split(' ').filter(Boolean), {
			stdio: ['ignore', 'inherit', 'inherit']
		})
	: null;
logger.info('service started', {
	port: server.port,
	jobsPort: jobs.port,
	concurrency: env.HANSI_CONCURRENCY,
	consumer: consumer !== null
});

const stopping = Promise.withResolvers<void>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (draining) {
			logger.warn('second signal, exiting without waiting for running jobs', { signal });
			consumer?.kill('SIGKILL');
			process.exit(1);
		}
		logger.info('shutting down after running jobs finish (signal again to force)', { signal });
		draining = true;
		// The consumer stops receiving, waits for the jobs it handed over and settles them.
		consumer?.kill('SIGTERM');
		stopping.resolve();
	});
}

if (consumer) {
	const code = await consumer.exited;
	if (!draining) {
		// Its deliveries go back to the queue, so the jobs it handed over stop here too.
		logger.error('queue consumer exited', { code });
		draining = true;
		worker.abort();
		process.exitCode = 1;
	} else if (code !== 0) {
		logger.error('queue consumer exited', { code });
		process.exitCode = 1;
	}
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
