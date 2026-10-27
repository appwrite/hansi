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
			const text = await request.clone().text();
			requests.push({
				method: request.method,
				path: url.pathname,
				body: text ? JSON.parse(text) : undefined
			});
			const handler = routes[`${request.method} ${url.pathname}`];
			return handler ? handler(request) : new Response('not found', { status: 404 });
		}
	});
	return `http://localhost:${server.port}`;
}

afterEach(async () => {
	await server?.stop(true);
	requests.length = 0;
});

describe('OrchestratorSandboxClient', () => {
	test('creates a sandbox from the archive, runs a command, and deletes it once', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () =>
				Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }, { status: 201 }),
			'POST /execute': () =>
				Response.json({ exitCode: 0, stdout: '4\n', stderr: '', durationMillis: 12 }),
			'DELETE /v1/sandbox/sbx-1': () => new Response(null, { status: 204 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1', apiKey: 'key' });

		const sandbox = await client.create({ archiveUrl: 'https://example.test/pr.tar.gz' });
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
		expect(requests[0]?.body).toMatchObject({
			image: 'toolchain:1',
			runtimeClass: 'gvisor',
			artifacts: [
				{ type: 'download', in: 'https://example.test/pr.tar.gz' },
				{ type: 'unarchive', depends: 'archive' }
			]
		});
		expect(requests[1]?.body).toEqual({ command: 'echo 4', timeoutSeconds: 30 });
		expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
	});

	test('refuses to run commands after close', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => Response.json({ id: 'sbx-1', status: 'ready', url: endpoint }),
			'DELETE /v1/sandbox/sbx-1': () => new Response(null, { status: 404 })
		});
		const sandbox = await new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' }).create({
			archiveUrl: 'https://example.test/pr.tar.gz'
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

		await expect(client.create({ archiveUrl: 'https://example.test/pr.tar.gz' })).rejects.toThrow(
			'download failed'
		);
		await Bun.sleep(10);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toContain('DELETE /v1/sandbox/sbx-2');
	});

	test('surfaces control plane errors', async () => {
		const endpoint = serve({
			'POST /v1/sandbox': () => new Response('bad image', { status: 400 })
		});
		const client = new OrchestratorSandboxClient({ endpoint, image: 'toolchain:1' });

		await expect(client.create({ archiveUrl: 'https://example.test/pr.tar.gz' })).rejects.toThrow(
			'400 bad image'
		);
	});
});
