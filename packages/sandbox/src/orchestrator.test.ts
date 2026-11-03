import { afterEach, describe, expect, test } from 'bun:test';
import { OrchestratorSandboxClient, SandboxError } from './orchestrator';

// One fake server plays both the orchestrator control plane and the sandbox agent.
type Handler = (request: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

function serve(routes: Record<string, Handler>) {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const json = request.headers.get('content-type') === 'application/json';
			const text = await request.clone().text();
			requests.push({
				method: request.method,
				path: url.pathname,
				body: json && text ? JSON.parse(text) : text || undefined
			});
			const handler =
				routes[`${request.method} ${url.pathname}`] ?? agent[`${request.method} ${url.pathname}`];
			return handler ? handler(request) : new Response('not found', { status: 404 });
		}
	});
	return `http://localhost:${server.port}`;
}

const UPLOAD = 'PUT /files/.hansi-workspace.tar.gz';
const UNPACK = '{ rm -f .hansi-workspace.tar.gz && tar -xzf -; } < .hansi-workspace.tar.gz';
const workspace = Promise.resolve(new Blob(['archive bytes']));

/** The sandbox agent's answers to the upload and the unpack, unless a test's routes say otherwise. */
const agent: Record<string, Handler> = {
	[UPLOAD]: () => new Response(null, { status: 204 })
};

/** Answers the unpack with exit 0 and every other command with `answer`. */
function execute(answer: () => Response): Handler {
	return async (request) => {
		const { command } = (await request.clone().json()) as { command: string };
		return command === UNPACK
			? Response.json({ exitCode: 0, stdout: '', stderr: '', durationMillis: 3 })
			: answer();
	};
}

afterEach(async () => {
	await server?.stop(true);
	requests.length = 0;
});

describe('OrchestratorSandboxClient', () => {
	test('creates a sandbox, unpacks the workspace, runs a command, and deletes it once', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () =>
				Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }, { status: 201 }),
			'POST /execute': execute(() =>
				Response.json({ exitCode: 0, stdout: '4\n', stderr: '', durationMillis: 12 })
			),
			'DELETE /v1/sandbox/sbx-1': () => new Response(null, { status: 204 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1', apiKey: 'key' });

		const sandbox = await client.create({ workspace });
		const result = await sandbox.run('echo 4', { timeoutMs: 30_000 });
		await sandbox.close();
		await sandbox.close();

		expect(result).toEqual({
			exitCode: 0,
			stdout: '4\n',
			stderr: '',
			timedOut: false,
			truncated: false
		});
		expect(requests[0]?.body).toMatchObject({ image: 'toolchain:1', runtimeClass: 'gvisor' });
		expect(requests[0]?.body).not.toHaveProperty('artifacts');
		expect(requests[1]).toMatchObject({ method: 'PUT', body: 'archive bytes' });
		expect(requests[2]?.body).toEqual({ command: UNPACK, timeoutSeconds: 120 });
		expect(requests[3]?.body).toEqual({ command: 'echo 4', timeoutSeconds: 30 });
		expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
	});

	test('reports a command the agent killed at its timeout', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }),
			'POST /execute': execute(() =>
				Response.json({ exitCode: 124, stdout: '', stderr: '', durationMillis: 2_003 })
			)
		});
		const sandbox = await new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' }).create({
			workspace
		});

		const result = await sandbox.run('sleep 10', { timeoutMs: 2_000 });

		expect(result).toMatchObject({ exitCode: 124, timedOut: true });
	});

	test('keeps a quick exit 124 as an ordinary exit', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }),
			'POST /execute': execute(() =>
				Response.json({ exitCode: 124, stdout: '', stderr: '', durationMillis: 5 })
			)
		});
		const sandbox = await new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' }).create({
			workspace
		});

		const result = await sandbox.run('exit 124', { timeoutMs: 2_000 });

		expect(result).toMatchObject({ exitCode: 124, timedOut: false });
	});

	test('refuses to run commands after close', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }),
			'POST /execute': execute(() => new Response('unexpected', { status: 500 })),
			'DELETE /v1/sandbox/sbx-1': () => new Response(null, { status: 404 })
		});
		const sandbox = await new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' }).create({
			workspace
		});

		await sandbox.close();

		await expect(sandbox.run('true', { timeoutMs: 1_000 })).rejects.toThrow(SandboxError);
	});

	test('deletes a sandbox that failed to start and reports why', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () =>
				Response.json({ id: 'sbx-2', status: 'failed', error: 'download failed' }, { status: 201 }),
			'DELETE /v1/sandbox/sbx-2': () => new Response(null, { status: 204 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' });

		await expect(client.create({ workspace })).rejects.toThrow('download failed');
		await Bun.sleep(10);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('DELETE /v1/sandbox/sbx-2');
	});

	test('deletes a sandbox whose upload fails and reports why', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-3', status: 'ready', url: endpoint }),
			[UPLOAD]: () => new Response('too large', { status: 413 }),
			'DELETE /v1/sandbox/sbx-3': () => new Response(null, { status: 204 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' });

		await expect(client.create({ workspace })).rejects.toThrow('upload: 413 too large');
		expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('DELETE /v1/sandbox/sbx-3');
	});

	test('deletes a sandbox whose workspace does not unpack and reports why', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-4', status: 'ready', url: endpoint }),
			'POST /execute': () =>
				Response.json({ exitCode: 2, stdout: '', stderr: 'gzip: invalid', durationMillis: 3 }),
			'DELETE /v1/sandbox/sbx-4': () => new Response(null, { status: 204 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' });

		await expect(client.create({ workspace })).rejects.toThrow('unpack: exit 2 gzip: invalid');
		expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('DELETE /v1/sandbox/sbx-4');
	});

	test('surfaces control plane errors', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => new Response('bad image', { status: 400 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' });

		await expect(client.create({ workspace })).rejects.toThrow('400 bad image');
	});
});
