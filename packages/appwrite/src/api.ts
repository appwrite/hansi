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

export class AppwriteApi {
	private readonly http: typeof fetch;

	constructor(private readonly config: AppwriteConfig) {
		this.http = config.fetch ?? fetch;
	}

	async request<T = void>(method: string, path: string, body: unknown): Promise<T> {
		const response = await this.http(`${this.config.endpoint.replace(/\/+$/, '')}${path}`, {
			method,
			headers: {
				'content-type': 'application/json',
				'x-appwrite-reviews-secret': this.config.secret
			},
			body: JSON.stringify(body)
		});
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
