// Bitbucket Cloud's REST API (2.0), the little of it the client needs: JSON over fetch, `next`
// page links, and the retries its rate limits ask for. https://developer.atlassian.com/cloud/bitbucket/rest/

export const BITBUCKET_API_URL = 'https://api.bitbucket.org/2.0';

export class BitbucketError extends Error {
	override readonly name = 'BitbucketError';

	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}

	/** The engine reads this the way it reads GitHub's 422: the request itself is the problem. */
	get unprocessable(): boolean {
		return this.status === 400 || this.status === 422;
	}
}

/** Times a rate-limited or unavailable request is tried again, and the longest wait between. */
const RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const PAGE_SIZE = 50;

type Query = Record<string, string | number | undefined>;

export interface BitbucketApiConfig {
	/** Defaults to Bitbucket Cloud's public API. */
	apiUrl?: string;
	fetch?: typeof fetch;
}

export class BitbucketApi {
	private readonly root: string;
	private readonly http: typeof fetch;

	constructor(
		private readonly token: () => Promise<string>,
		config: BitbucketApiConfig = {}
	) {
		this.root = (config.apiUrl ?? BITBUCKET_API_URL).replace(/\/+$/, '');
		this.http = config.fetch ?? fetch;
	}

	/** Sends `body` as JSON and answers the JSON Bitbucket returns. */
	async request<T>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		input: { query?: Query; body?: Record<string, unknown> } = {}
	): Promise<T> {
		const text = await (await this.send(method, this.url(path, input.query), input.body)).text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	/** A raw body, such as a file or a diff. */
	async raw(path: string, query: Query = {}): Promise<string> {
		return (await this.send('GET', this.url(path, query))).text();
	}

	/** Every item of a paginated list, following `next`. */
	async list<T>(path: string, query: Query = {}): Promise<T[]> {
		const items: T[] = [];
		let next: string | undefined = this.url(path, { ...query, pagelen: PAGE_SIZE }).toString();
		while (next) {
			const response = await this.send('GET', new URL(next));
			const page = (await response.json()) as { values?: T[]; next?: string };
			items.push(...(page.values ?? []));
			next = page.next;
		}
		return items;
	}

	private url(path: string, query: Query = {}): URL {
		const url = new URL(`${this.root}${path}`);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url;
	}

	private async send(method: string, url: URL, body?: Record<string, unknown>) {
		for (let attempt = 0; ; attempt++) {
			const response = await this.http(url, {
				method,
				headers: {
					authorization: `Bearer ${await this.token()}`,
					accept: 'application/json',
					...(body ? { 'content-type': 'application/json' } : {})
				},
				...(body ? { body: JSON.stringify(body) } : {})
			});
			if (response.ok) return response;
			if ((response.status === 429 || response.status === 503) && attempt < RETRIES) {
				await Bun.sleep(retryAfter(response, attempt));
				continue;
			}
			const error = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
			throw new BitbucketError(
				response.status,
				`Bitbucket ${method} ${url.pathname} failed with ${response.status}: ${error.error?.message ?? response.statusText}`
			);
		}
	}
}

function retryAfter(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get('retry-after'));
	const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(wait, MAX_RETRY_WAIT_MS);
}
