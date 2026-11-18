// Origin's REST API, the little of it the client needs: JSON over fetch, Google RPC-style errors,
// page tokens, and the retries its rate limits ask for. https://cursor.com/docs/api/origin

export const ORIGIN_API_URL = 'https://api.cursor.com/v1/origin';

/** gRPC codes Origin answers a request it will never accept with, e.g. an anchor off the diff. */
const INVALID_ARGUMENT = 3;
const FAILED_PRECONDITION = 9;

export class OriginError extends Error {
	override readonly name = 'OriginError';

	constructor(
		readonly status: number,
		/** The gRPC status code in Origin's error body, 0 when the body had none. */
		readonly code: number,
		message: string
	) {
		super(message);
	}

	/** The engine reads this the way it reads GitHub's 422: the request itself is the problem. */
	get unprocessable(): boolean {
		return (
			this.status === 400 && (this.code === INVALID_ARGUMENT || this.code === FAILED_PRECONDITION)
		);
	}
}

/** Times a rate-limited or unavailable request is tried again, and the longest wait between. */
const RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const PAGE_SIZE = 100;

export interface OriginApiConfig {
	/** Defaults to Origin's public API. */
	apiUrl?: string;
	fetch?: typeof fetch;
}

export class OriginApi {
	private readonly root: string;
	private readonly http: typeof fetch;

	constructor(
		private readonly token: () => Promise<string>,
		config: OriginApiConfig = {}
	) {
		this.root = (config.apiUrl ?? ORIGIN_API_URL).replace(/\/+$/, '');
		this.http = config.fetch ?? fetch;
	}

	/** A GET sends `body` as the query string; every other method as JSON. */
	async request<T>(
		method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
		path: string,
		body?: Record<string, unknown>
	): Promise<T> {
		const url = new URL(`${this.root}${path}`);
		if (method === 'GET' && body) {
			for (const [key, value] of Object.entries(body)) {
				if (value === undefined) continue;
				for (const item of Array.isArray(value) ? value : [value]) {
					url.searchParams.append(key, String(item));
				}
			}
		}

		for (let attempt = 0; ; attempt++) {
			const response = await this.http(url, {
				method,
				headers: {
					authorization: `Bearer ${await this.token()}`,
					accept: 'application/json',
					...(method === 'GET' ? {} : { 'content-type': 'application/json' })
				},
				...(method === 'GET' || !body ? {} : { body: JSON.stringify(body) })
			});
			if (response.ok) {
				const text = await response.text();
				return (text ? JSON.parse(text) : {}) as T;
			}
			if ((response.status === 429 || response.status === 503) && attempt < RETRIES) {
				await Bun.sleep(retryAfter(response, attempt));
				continue;
			}
			const error = (await response.json().catch(() => ({}))) as {
				code?: number;
				message?: string;
			};
			throw new OriginError(
				response.status,
				error.code ?? 0,
				`Origin ${method} ${path} failed with ${response.status}: ${error.message ?? response.statusText}`
			);
		}
	}

	/** Every item of a paginated list, following `nextPageToken`. */
	async list<T>(path: string, field: string, query: Record<string, unknown> = {}): Promise<T[]> {
		const items: T[] = [];
		let pageToken = '';
		do {
			const page = await this.request<Record<string, unknown> & { nextPageToken?: string }>(
				'GET',
				path,
				{ ...query, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }
			);
			items.push(...((page[field] as T[] | undefined) ?? []));
			pageToken = page.nextPageToken ?? '';
		} while (pageToken);
		return items;
	}
}

function retryAfter(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get('retry-after'));
	const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(wait, MAX_RETRY_WAIT_MS);
}
