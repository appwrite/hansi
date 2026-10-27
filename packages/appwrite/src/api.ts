import type { AppwriteConfig } from './config';

// Appwrite's internal Reviews API. It is not a project API: the project goes in each body, so the
// calls are not metered as the customer's requests, and a shared secret authenticates them.

export class AppwriteError extends Error {
	override readonly name = 'AppwriteError';

	constructor(
		readonly status: number,
		/** Appwrite's error type, e.g. `review_status_invalid`. */
		readonly type: string,
		message: string
	) {
		super(message);
	}
}

/** Times a call that hit Appwrite's abuse limit is tried again. */
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

export class AppwriteApi {
	private readonly http: typeof fetch;

	constructor(private readonly config: AppwriteConfig) {
		this.http = config.fetch ?? fetch;
	}

	async request<T = void>(method: string, path: string, body: unknown): Promise<T> {
		let response: Response;
		for (let attempt = 0; ; attempt++) {
			response = await this.http(`${this.config.endpoint.replace(/\/+$/, '')}${path}`, {
				method,
				headers: {
					'content-type': 'application/json',
					'x-appwrite-reviews-secret': this.config.secret
				},
				body: JSON.stringify(body)
			});
			// Each route allows a number of calls per review a minute. Nothing was stored, so the
			// same call is safe to send again once the window resets.
			if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
			await response.body?.cancel();
			await Bun.sleep(rateLimitWait(response, attempt));
		}
		if (!response.ok) {
			const text = await response.text();
			let error: { type?: string; message?: string } = {};
			try {
				error = JSON.parse(text);
			} catch {
				// Not Appwrite's error shape: a proxy or a crash. The status says enough.
			}
			throw new AppwriteError(
				response.status,
				error.type ?? '',
				`Appwrite ${method} ${path}: ${response.status} ${error.message ?? text.slice(0, 200)}`
			);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}
}

/** Until the window resets, as Appwrite announces it, or a growing pause without that. */
function rateLimitWait(response: Response, attempt: number): number {
	const reset = Number(response.headers.get('x-ratelimit-reset'));
	const wait = reset > 0 ? reset * 1000 - Date.now() : 1000 * 2 ** attempt;
	return Math.min(Math.max(wait, 0), MAX_RATE_LIMIT_WAIT_MS);
}
