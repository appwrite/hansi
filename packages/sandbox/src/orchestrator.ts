import type { CommandResult, Sandbox, SandboxClient, SandboxSpec } from '@hansi/engine';

// Sandboxes on the open-runtimes orchestrator (docs/sandboxes.md there). The control plane
// creates and deletes them; commands go straight to the sandbox's own URL, served by the
// sandbox agent the orchestrator installs into every sandbox.

export interface OrchestratorConfig {
	/** Orchestrator API, e.g. `http://orchestrator:8080`. */
	endpoint: string;
	apiKey?: string;
	/** The published toolchain image (Node, Python, PHP with Composer, Go). */
	image: string;
	/** Where the image serves the sandbox contract. */
	port?: number;
	cpu?: number;
	/** MiB. */
	memory?: number;
	runtimeClass?: 'runc' | 'gvisor' | 'kata';
	fetch?: typeof fetch;
}

interface SandboxStatus {
	id: string;
	status: 'creating' | 'ready' | 'failed' | 'deleting';
	url?: string;
	error?: string;
}

interface ExecuteResponse {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMillis: number;
	truncated?: boolean;
}

/** Margin past a command's own timeout before the request carrying it is given up on. */
const REQUEST_GRACE_MS = 10_000;
const ARCHIVE = 'pr.tar.gz';

export class SandboxError extends Error {
	override readonly name = 'SandboxError';
}

export class OrchestratorSandboxClient implements SandboxClient {
	private readonly http: typeof fetch;

	constructor(private readonly config: OrchestratorConfig) {
		this.http = config.fetch ?? fetch;
	}

	async create(spec: SandboxSpec): Promise<Sandbox> {
		const response = await this.request('POST', '/v1/sandbox', {
			image: this.config.image,
			port: this.config.port ?? 3000,
			cpu: this.config.cpu ?? 2,
			memory: this.config.memory ?? 2048,
			runtimeClass: this.config.runtimeClass ?? 'gvisor',
			environment: spec.environment,
			// Requests carry one command each; the per-command timeout bounds them.
			timeoutSeconds: 0,
			idleTimeoutSeconds: spec.idleTimeoutSeconds ?? 3600,
			artifacts: [
				{ id: 'archive', type: 'download', in: spec.archiveUrl, out: ARCHIVE },
				{ id: 'unpack', type: 'unarchive', in: ARCHIVE, out: '.', depends: 'archive' }
			]
		});
		const status = (await response.json()) as SandboxStatus;

		const sandbox = new OrchestratorSandbox(status.id, status.url, this.http, () =>
			this.delete(status.id)
		);
		if (status.status !== 'ready' || !status.url) {
			await sandbox.close();
			throw new SandboxError(`sandbox ${status.id} is ${status.status}: ${status.error ?? ''}`);
		}
		return sandbox;
	}

	private async delete(id: string): Promise<void> {
		await this.request('DELETE', `/v1/sandbox/${encodeURIComponent(id)}`, undefined, [404]);
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		allowed: number[] = []
	): Promise<Response> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

		const response = await this.http(new URL(path, this.config.endpoint), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok && !allowed.includes(response.status)) {
			throw new SandboxError(
				`orchestrator ${method} ${path}: ${response.status} ${await response.text()}`
			);
		}
		return response;
	}
}

class OrchestratorSandbox implements Sandbox {
	private closed?: Promise<void>;

	constructor(
		readonly id: string,
		// The URL is a capability: anyone holding it can run commands. Never log it.
		private readonly url: string | undefined,
		private readonly http: typeof fetch,
		private readonly teardown: () => Promise<void>
	) {}

	async run(command: string, { timeoutMs }: { timeoutMs: number }): Promise<CommandResult> {
		if (this.closed || !this.url) throw new SandboxError(`sandbox ${this.id} is closed`);

		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		let response: Response;
		try {
			response = await this.http(new URL('/execute', this.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ command, timeoutSeconds }),
				signal: AbortSignal.timeout(timeoutSeconds * 1000 + REQUEST_GRACE_MS)
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				return { exitCode: null, stdout: '', stderr: '', timedOut: true, truncated: false };
			}
			throw error;
		}
		if (!response.ok) {
			throw new SandboxError(`sandbox ${this.id} execute: ${response.status}`);
		}

		const result = (await response.json()) as ExecuteResponse;
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: result.exitCode === null && result.durationMillis >= timeoutSeconds * 1000,
			truncated: result.truncated ?? false
		};
	}

	close(): Promise<void> {
		this.closed ??= this.teardown();
		return this.closed;
	}
}
