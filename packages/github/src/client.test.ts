import { afterEach, describe, expect, test } from 'bun:test';
import { InstallationGitHubClientFactory } from './client';
import type { InstallationTokens } from './tokens';

// The client against a local fake of GitHub's API: the hansi.codes helpers it wraps have their
// own tests, so these cover what is Appwrite's: tokens, the app, and the archive URL.

let server: ReturnType<typeof Bun.serve> | undefined;
const seen: { path: string; auth: string | null }[] = [];

function serve(routes: Record<string, () => Response>): string {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			seen.push({ path: url.pathname, auth: request.headers.get('authorization') });
			const route = routes[`${request.method} ${url.pathname}`];
			return route ? route() : new Response('{"message":"Not Found"}', { status: 404 });
		}
	});
	return `http://localhost:${server.port}`;
}

afterEach(async () => {
	await server?.stop(true);
	seen.length = 0;
});

function tokens(expiresInMs: number) {
	let minted = 0;
	const source: InstallationTokens = {
		async get({ repositoryId }) {
			minted++;
			return {
				token: `${repositoryId}-${minted}`,
				expiresAt: new Date(Date.now() + expiresInMs),
				app: { id: '9', slug: 'hansi' }
			};
		}
	};
	return { source, minted: () => minted };
}

const repository = { projectId: 'project1', repositoryId: 'repo1', owner: 'acme', name: 'app' };
const pull = () =>
	Response.json({
		number: 7,
		title: 'Fix',
		body: null,
		user: { login: 'octocat' },
		author_association: 'MEMBER',
		draft: false,
		state: 'open',
		merged: false,
		base: { ref: 'main', sha: 'b', repo: { clone_url: 'https://github.test/acme/app.git' } },
		head: { ref: 'fix', sha: 'h' }
	});

describe('InstallationGitHubClientFactory', () => {
	test('acts as the app the token is for, with the installation token', async () => {
		const apiUrl = serve({ 'GET /repos/acme/app/pulls/7': pull });
		const t = tokens(3_600_000);
		const { github, app } = await new InstallationGitHubClientFactory(t.source, {
			apiUrl
		}).forRepository(repository);

		expect(app).toEqual({ id: '9', slug: 'hansi' });
		expect(await github.getPullRequest(7)).toMatchObject({
			number: 7,
			body: '',
			baseSha: 'b',
			headSha: 'h',
			cloneUrl: 'https://github.test/acme/app.git'
		});
		await github.getPullRequest(7);
		expect(seen.map((r) => r.auth)).toEqual(['token repo1-1', 'token repo1-1']);
		expect(t.minted()).toBe(1);
	});

	test('renews a token that is about to expire', async () => {
		const apiUrl = serve({ 'GET /repos/acme/app/pulls/7': pull });
		const t = tokens(60_000);
		const { github } = await new InstallationGitHubClientFactory(t.source, {
			apiUrl
		}).forRepository(repository);

		await github.getPullRequest(7);
		expect(seen[0]?.auth).toBe('token repo1-2');
		expect(await github.getInstallationToken()).toBe('repo1-3');
	});

	test('reads the archive URL from the redirect without following it', async () => {
		const apiUrl = serve({
			'GET /repos/acme/app/tarball/h': () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://codeload.github.test/acme/app/legacy.tar.gz/h?token=x' }
				})
		});
		const { github } = await new InstallationGitHubClientFactory(tokens(3_600_000).source, {
			apiUrl
		}).forRepository(repository);

		expect(await github.getArchiveUrl('h')).toBe(
			'https://codeload.github.test/acme/app/legacy.tar.gz/h?token=x'
		);
		expect(seen).toHaveLength(1);
	});

	test('a missing file reads as null', async () => {
		const apiUrl = serve({});
		const { github } = await new InstallationGitHubClientFactory(tokens(3_600_000).source, {
			apiUrl
		}).forRepository(repository);

		expect(await github.getFileContent('.hansi.json', 'b')).toBeNull();
	});
});
