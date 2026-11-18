// GitLab's REST API (v4), the little of it the client needs: JSON over fetch, page numbers, and
// the retries its rate limits ask for. https://docs.gitlab.com/api/rest/

export const GITLAB_API_URL = 'https://gitlab.com/api/v4';

export class GitLabError extends Error {
	override readonly name = 'GitLabError';

	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}

	/**
	 * The engine reads this the way it reads GitHub's 422: the request itself is the problem, e.g.
	 * a comment position GitLab has no diff line for, which it answers with 400.
	 */
	get unprocessable(): boolean {
		return this.status === 400 || this.status === 422;
	}
}

/** Times a rate-limited or unavailable request is tried again, and the longest wait between. */
const RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const PAGE_SIZE = 100;

type Query = Record<string, string | number | boolean | undefined>;

export interface GitLabApiConfig {
	/** The instance's API root. Defaults to GitLab.com. */
	apiUrl?: string;
	fetch?: typeof fetch;
}

export class GitLabApi {
	private readonly root: string;
	private readonly http: typeof fetch;

	constructor(
		private readonly token: () => Promise<string>,
		config: GitLabApiConfig = {}
	) {
		this.root = (config.apiUrl ?? GITLAB_API_URL).replace(/\/+$/, '');
		this.http = config.fetch ?? fetch;
	}

	/** Sends `body` as JSON and answers the JSON GitLab returns. */
	async request<T>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		input: { query?: Query; body?: Record<string, unknown> } = {}
	): Promise<T> {
		const text = await (await this.send(method, path, input)).text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	/** A file's raw contents. */
	async raw(path: string, query: Query = {}): Promise<string> {
		return (await this.send('GET', path, { query })).text();
	}

	/** Every item of a paginated list, following `x-next-page`. */
	async list<T>(path: string, query: Query = {}): Promise<T[]> {
		const items: T[] = [];
		let page = '1';
		while (page) {
			const response = await this.send('GET', path, {
				query: { ...query, per_page: PAGE_SIZE, page }
			});
			items.push(...((await response.json()) as T[]));
			page = response.headers.get('x-next-page') ?? '';
		}
		return items;
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
					authorization: `Bearer ${await this.token()}`,
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
			const error = (await response.json().catch(() => ({}))) as {
				message?: unknown;
				error?: unknown;
			};
			const message = error.message ?? error.error ?? response.statusText;
			throw new GitLabError(
				response.status,
				`GitLab ${method} ${path} failed with ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`
			);
		}
	}
}

function retryAfter(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get('retry-after'));
	const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(wait, MAX_RETRY_WAIT_MS);
}
