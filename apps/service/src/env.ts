import { z } from 'zod';
import { isProviderId, missingConfig, providerIds, providerOf } from './models';

const secret = z.string().min(1).optional();

const modelId = z
	.string()
	.min(1)
	.refine((id) => isProviderId(providerOf(id)) && id.length > providerOf(id).length + 1, {
		message: `Use provider:model, with a provider of ${providerIds.join(', ')}`
	});

const schema = z
	.object({
		HANSI_PORT: z.coerce.number().int().positive().default(8080),
		HANSI_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
		/** Jobs one process runs at once. Each review holds a checkout, and a sandbox if it runs commands. */
		HANSI_CONCURRENCY: z.coerce.number().int().positive().default(4),

		HANSI_APPWRITE_ENDPOINT: z.url(),
		HANSI_APPWRITE_SECRET: z.string().min(1),

		/**
		 * Where the queue consumer hands over jobs, on loopback. The consumer reads `HANSI_QUEUE_*`
		 * itself (`apps/consumer`).
		 */
		HANSI_JOBS_PORT: z.coerce.number().int().positive().default(8081),
		/**
		 * Starts the queue consumer as a child of this process, e.g. `php apps/consumer/consumer.php`.
		 * The image sets it; unset, jobs only arrive from whoever calls the jobs port.
		 */
		HANSI_CONSUMER_COMMAND: z.string().min(1).optional(),

		/** The orchestrator's sandboxes, for the agents' commands. Without it, reviews only read. */
		HANSI_ORCHESTRATOR_ENDPOINT: z.url().optional(),
		HANSI_ORCHESTRATOR_KEY: z.string().min(1).optional(),
		HANSI_SANDBOX_IMAGE: z.string().min(1).optional(),

		/**
		 * Model ids as `provider:model`, e.g. `bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0`.
		 * The provider must be configured below. Appwrite takes over model choice once it serves keys
		 * and models.
		 */
		HANSI_REVIEW_MODEL: modelId,
		/** The verifier's model. Defaults to the reviewer's. */
		HANSI_VERIFY_MODEL: modelId.optional(),

		HANSI_OPENAI_API_KEY: secret,
		HANSI_OPENAI_BASE_URL: z.url().optional(),
		HANSI_ANTHROPIC_API_KEY: secret,
		HANSI_ANTHROPIC_BASE_URL: z.url().optional(),
		HANSI_XAI_API_KEY: secret,
		HANSI_XAI_BASE_URL: z.url().optional(),
		HANSI_GOOGLE_API_KEY: secret,
		HANSI_GOOGLE_BASE_URL: z.url().optional(),
		HANSI_OPENROUTER_API_KEY: secret,
		HANSI_OPENROUTER_BASE_URL: z.url().optional(),
		/** Amazon Bedrock: a region, and a Bedrock API key or an IAM access key pair. */
		HANSI_BEDROCK_REGION: z.string().min(1).optional(),
		HANSI_BEDROCK_API_KEY: secret,
		HANSI_BEDROCK_ACCESS_KEY_ID: secret,
		HANSI_BEDROCK_SECRET_ACCESS_KEY: secret,
		HANSI_BEDROCK_SESSION_TOKEN: secret,
		/** Any OpenAI-compatible API (Ollama, vLLM, LiteLLM, Groq, …). The key is optional. */
		HANSI_OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
		HANSI_OPENAI_COMPATIBLE_API_KEY: secret
	})
	.refine((env) => !env.HANSI_ORCHESTRATOR_ENDPOINT || env.HANSI_SANDBOX_IMAGE, {
		message: 'Sandboxes need an image',
		path: ['HANSI_SANDBOX_IMAGE']
	})
	.superRefine((env, context) => {
		const providers = new Map<string, string>();
		for (const key of ['HANSI_VERIFY_MODEL', 'HANSI_REVIEW_MODEL'] as const) {
			if (env[key]) providers.set(providerOf(env[key]), key);
		}
		for (const [provider, key] of providers) {
			if (!isProviderId(provider)) continue;
			for (const missing of missingConfig(provider, env)) {
				context.addIssue({
					code: 'custom',
					message: `Required by ${key} (${provider})`,
					path: [missing]
				});
			}
		}
	});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
	const result = schema.safeParse(source);
	if (!result.success) {
		throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}
