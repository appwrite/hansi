import { z } from 'zod';
import { isProviderId, missingConfig, parseModelId, providerIds, reasoningEfforts } from './models';

const modelId = z
	.string()
	.min(1)
	.refine(
		(id) => {
			const { provider, model } = parseModelId(id);
			return isProviderId(provider) && model.length > 0;
		},
		{ message: `Use provider:model, with a provider of ${providerIds.join(', ')}` }
	);

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
		 * Appwrite takes over model choice once it serves keys and models.
		 */
		HANSI_REVIEW_MODEL: modelId,
		/** The verifier's model. Defaults to the reviewer's, and uses the same provider. */
		HANSI_VERIFY_MODEL: modelId.optional(),
		/** Reasoning effort per model. Unset leaves the provider's default. */
		HANSI_REVIEW_REASONING: z.enum(reasoningEfforts).optional(),
		/** Defaults to the reviewer's. */
		HANSI_VERIFY_REASONING: z.enum(reasoningEfforts).optional(),
		/**
		 * The provider's API key. On Bedrock, a Bedrock API key or an IAM key pair as
		 * `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]`.
		 */
		HANSI_AI_SECRET: z.string().min(1).optional(),
		/** The AWS region, for Bedrock. */
		HANSI_AI_REGION: z.string().min(1).optional(),
		/** The provider's API, instead of its default. Required for openai-compatible. */
		HANSI_AI_BASE_URL: z.url().optional()
	})
	.refine((env) => !env.HANSI_ORCHESTRATOR_ENDPOINT || env.HANSI_SANDBOX_IMAGE, {
		message: 'Sandboxes need an image',
		path: ['HANSI_SANDBOX_IMAGE']
	})
	.superRefine((env, context) => {
		const { provider } = parseModelId(env.HANSI_REVIEW_MODEL);
		if (!isProviderId(provider)) return;
		if (env.HANSI_VERIFY_MODEL && parseModelId(env.HANSI_VERIFY_MODEL).provider !== provider) {
			context.addIssue({
				code: 'custom',
				message: `Use the review model's provider, ${provider}: there is one HANSI_AI_SECRET`,
				path: ['HANSI_VERIFY_MODEL']
			});
		}
		for (const missing of missingConfig(provider, env)) {
			context.addIssue({ code: 'custom', message: `Required by ${provider}`, path: [missing] });
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
