// Gitea's REST API (v1), the little of it the client needs: JSON over fetch, page numbers, and
// the retries a busy instance asks for. https://docs.gitea.com/development/api-usage

export const GITEA_API_URL = 'https://gitea.com/api/v1';

export class GiteaError extends Error {
	override readonly name = 'GiteaError';

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
/** Gitea's default largest page. */
const PAGE_SIZE = 50;

type Query = Record<string, string | number | undefined>;

export interface GiteaApiConfig {
	/** The instance's API root, e.g. `https://git.example.com/api/v1`. Defaults to gitea.com. */
	apiUrl?: string;
	fetch?: typeof fetch;
}

export class GiteaApi {
	private readonly root: string;
	private readonly http: typeof fetch;

	constructor(
		private readonly token: () => Promise<string>,
		config: GiteaApiConfig = {}
	) {
		this.root = (config.apiUrl ?? GITEA_API_URL).replace(/\/+$/, '');
		this.http = config.fetch ?? fetch;
	}

	/** Sends `body` as JSON and answers the JSON Gitea returns. */
	async request<T>(
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		path: string,
		input: { query?: Query; body?: Record<string, unknown> } = {}
	): Promise<T> {
		const text = await (await this.send(method, path, input)).text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	/** A raw body, such as a file or a diff. */
	async raw(path: string, query: Query = {}): Promise<string> {
		return (await this.send('GET', path, { query })).text();
	}

	/** Every item of a paginated list, page by page until one comes back short. */
	async list<T>(path: string, query: Query = {}): Promise<T[]> {
		const items: T[] = [];
		for (let page = 1; ; page++) {
			const response = await this.send('GET', path, {
				query: { ...query, limit: PAGE_SIZE, page }
			});
			const values = (await response.json()) as T[];
			items.push(...values);
			if (values.length < PAGE_SIZE) return items;
		}
	}

	private async send(
		method: string,
		path: string,
		input: { query?: Query; body?: Record<string, unknown> }
	): Promise<Response> {
		const url = new URL(`${this.root}${path}`);
		for (const [key, value] of Object.entries(input.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		for (let attempt = 0; ; attempt++) {
			const response = await this.http(url, {
				method,
				headers: {
					authorization: `token ${await this.token()}`,
					accept: 'application/json',
					...(input.body ? { 'content-type': 'application/json' } : {})
				},
				...(input.body ? { body: JSON.stringify(input.body) } : {})
			});
			if (response.ok) return response;
			if ((response.status === 429 || response.status === 503) && attempt < RETRIES) {
				await Bun.sleep(retryAfter(response, attempt));
				continue;
			}
			const error = (await response.json().catch(() => ({}))) as { message?: string };
			throw new GiteaError(
				response.status,
				`Gitea ${method} ${path} failed with ${response.status}: ${error.message ?? response.statusText}`
			);
		}
	}
}

function retryAfter(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get('retry-after'));
	const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(wait, MAX_RETRY_WAIT_MS);
}
