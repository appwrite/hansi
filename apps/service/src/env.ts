import { REVIEWS_QUEUE } from '@hansi/appwrite';
import { z } from 'zod';

const schema = z.object({
	HANSI_PORT: z.coerce.number().int().positive().default(8080),
	HANSI_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
	/** Jobs one process runs at once. Each review holds a checkout and a sandbox. */
	HANSI_CONCURRENCY: z.coerce.number().int().positive().default(4),

	HANSI_APPWRITE_ENDPOINT: z.url(),
	HANSI_APPWRITE_SECRET: z.string().min(1),

	/** Appwrite's NATS queue connection, `nats://user:pass@host:4222`. */
	HANSI_QUEUE_URL: z.url({ protocol: /^nats$/ }),
	HANSI_QUEUE_NAME: z.string().min(1).default(REVIEWS_QUEUE),

	HANSI_ORCHESTRATOR_ENDPOINT: z.url(),
	HANSI_ORCHESTRATOR_KEY: z.string().min(1).optional(),
	HANSI_SANDBOX_IMAGE: z.string().min(1),

	/**
	 * AI SDK model ids, resolved by the SDK's global provider (the AI Gateway by default, which
	 * reads AI_GATEWAY_API_KEY). Appwrite takes over model choice once it serves keys and models.
	 */
	HANSI_REVIEW_MODEL: z.string().min(1),
	/** The verifier's model. Defaults to the reviewer's. */
	HANSI_VERIFY_MODEL: z.string().min(1).optional()
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
	const result = schema.safeParse(source);
	if (!result.success) {
		throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}
