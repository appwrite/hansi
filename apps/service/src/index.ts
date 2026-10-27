import {
	AppwriteInstallationTokens,
	AppwriteJobSource,
	AppwriteResultsSink,
	type AppwriteConfig
} from '@hansi/appwrite';
import { InstallationGitHubClientFactory } from '@hansi/github';
import { OrchestratorSandboxClient } from '@hansi/sandbox';
import { parseEnv } from './env';
import { createHandlers } from './handlers';
import { createLogger } from './logger';
import { startHealthServer } from './server';
import { runWorker } from './worker';

const env = parseEnv(process.env);
const logger = createLogger(env.HANSI_LOG_LEVEL, { service: 'hansi' });

const appwrite: AppwriteConfig = {
	endpoint: env.HANSI_APPWRITE_ENDPOINT,
	secret: env.HANSI_APPWRITE_SECRET
};
const source = new AppwriteJobSource(
	{ url: env.HANSI_QUEUE_URL, name: env.HANSI_QUEUE_NAME },
	{
		onDiscard: (reason, details) => logger.error('queue message discarded', { reason, ...details })
	}
);
const sink = new AppwriteResultsSink(appwrite);
const github = new InstallationGitHubClientFactory(new AppwriteInstallationTokens(appwrite));
const sandboxes = new OrchestratorSandboxClient({
	endpoint: env.HANSI_ORCHESTRATOR_ENDPOINT,
	apiKey: env.HANSI_ORCHESTRATOR_KEY,
	image: env.HANSI_SANDBOX_IMAGE
});
const handlers = createHandlers(
	{ github, sandboxes, results: sink },
	{ reviewer: env.HANSI_REVIEW_MODEL, verifier: env.HANSI_VERIFY_MODEL }
);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (controller.signal.aborted) {
			logger.warn('second signal, exiting without waiting for running jobs', { signal });
			process.exit(1);
		}
		logger.info('shutting down after running jobs finish (signal again to force)', { signal });
		controller.abort();
	});
}

const server = startHealthServer({
	port: env.HANSI_PORT,
	draining: () => controller.signal.aborted
});
logger.info('service started', { port: server.port, concurrency: env.HANSI_CONCURRENCY });

try {
	await runWorker({
		source,
		sink,
		handlers,
		logger,
		concurrency: env.HANSI_CONCURRENCY,
		signal: controller.signal
	});
} catch (error) {
	logger.error('worker stopped', { err: error });
	process.exitCode = 1;
}

await source.close();
await server.stop();
logger.info('service stopped');
process.exit();
