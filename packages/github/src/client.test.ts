import { afterEach, describe, expect, test } from 'bun:test';
import { GitHubError, InstallationGitHubClientFactory } from './client';
import type { InstallationTokens } from './tokens';

// A fake GitHub API: routes by method and path, and records every request.
type Handler = (request: Request, url: URL) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];

function serve(routes: Record<string, Handler>): string {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.clone().text();
			requests.push({
				method: request.method,
				path: url.pathname + url.search,
				auth: request.headers.get('authorization'),
				body: text ? JSON.parse(text) : undefined
			});
			const handler = routes[`${request.method} ${url.pathname}`];
			return handler ? handler(request, url) : new Response('not found', { status: 404 });
		}
	});
	return `http://localhost:${server.port}`;
}

afterEach(async () => {
	await server?.stop(true);
	requests.length = 0;
});

function tokens(expiresInMs = 3_600_000) {
	let minted = 0;
	const source: InstallationTokens = {
		async get({ repositoryId }) {
			minted++;
			return {
				token: `${repositoryId}-token-${minted}`,
				expiresAt: new Date(Date.now() + expiresInMs)
			};
		}
	};
	return { source, minted: () => minted };
}

const repository = { projectId: 'project-1', repositoryId: '42', owner: 'acme', name: 'app' };

async function client(apiUrl: string, expiresInMs?: number) {
	const t = tokens(expiresInMs);
	const factory = new InstallationGitHubClientFactory(t.source, {
		apiUrl,
		webUrl: 'https://github.test'
	});
	return { github: await factory.forRepository(repository), minted: t.minted };
}

describe('RestGitHubClient', () => {
	test('reads a pull request with the installation token', async () => {
		const api = serve({
			'GET /repos/acme/app/pulls/7': () =>
				Response.json({
					number: 7,
					title: 'Fix',
					body: null,
					user: { login: 'octocat' },
					author_association: 'MEMBER',
					draft: false,
					state: 'open',
					merged: false,
					base: { ref: 'main', sha: 'b' },
					head: { ref: 'fix', sha: 'h' },
					html_url: 'https://github.test/acme/app/pull/7'
				})
		});
		const { github, minted } = await client(api);
		expect(await github.getPullRequest(7)).toMatchObject({
			number: 7,
			body: '',
			author: 'octocat',
			authorAssociation: 'MEMBER',
			base: { sha: 'b' },
			head: { sha: 'h' }
		});
		await github.getPullRequest(7);
		expect(requests[0]!.auth).toBe('Bearer 42-token-1');
		expect(minted()).toBe(1);
		expect(await github.gitRemote()).toEqual({
			url: 'https://github.test/acme/app.git',
			token: '42-token-1'
		});
	});

	test('renews a token close to its expiry', async () => {
		const api = serve({ 'GET /repos/acme/app/pulls/7/files': () => Response.json([]) });
		const { github, minted } = await client(api, 60_000);
		await github.listPullRequestFiles(7);
		await github.listPullRequestFiles(7);
		expect(minted()).toBe(2);
	});

	test('pages through pull request files', async () => {
		const file = (i: number) => ({
			filename: `f${i}.ts`,
			status: 'added',
			additions: 1,
			deletions: 0,
			patch: '@@ -0,0 +1 @@\n+x'
		});
		const api = serve({
			'GET /repos/acme/app/pulls/7/files': (_, url) => {
				const page = Number(url.searchParams.get('page'));
				return Response.json(
					Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => file((page - 1) * 100 + i))
				);
			}
		});
		const { github } = await client(api);
		const files = await github.listPullRequestFiles(7);
		expect(files).toHaveLength(103);
		expect(files[0]).toEqual({
			path: 'f0.ts',
			previousPath: undefined,
			status: 'added',
			additions: 1,
			deletions: 0,
			patch: '@@ -0,0 +1 @@\n+x'
		});
	});

	test('creates a review with single and multi-line comments', async () => {
		const api = serve({
			'POST /repos/acme/app/pulls/7/reviews': () =>
				Response.json({ id: 5, html_url: 'https://github.test/review/5' })
		});
		const { github } = await client(api);
		const created = await github.createReview(7, {
			commitId: 'h',
			event: 'COMMENT',
			body: 'Summary',
			comments: [
				{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'one line' },
				{ path: 'a.ts', line: 9, startLine: 7, side: 'RIGHT', body: 'three lines' }
			]
		});
		expect(created).toEqual({ id: 5, url: 'https://github.test/review/5' });
		expect(requests[0]!.body).toEqual({
			commit_id: 'h',
			event: 'COMMENT',
			body: 'Summary',
			comments: [
				{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'one line' },
				{
					path: 'a.ts',
					line: 9,
					side: 'RIGHT',
					body: 'three lines',
					start_line: 7,
					start_side: 'RIGHT'
				}
			]
		});
	});

	test('resolves the thread a comment belongs to', async () => {
		const api = serve({
			'GET /repos/acme/app/pulls/comments/11': () =>
				Response.json({
					id: 11,
					pull_request_url: 'https://api.github.test/repos/acme/app/pulls/7'
				}),
			'POST /graphql': async (request) => {
				const { query, variables } = (await request.json()) as {
					query: string;
					variables: Record<string, unknown>;
				};
				if (query.startsWith('mutation'))
					return Response.json({
						data: { resolveReviewThread: { thread: { id: variables.threadId } } }
					});
				return Response.json({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [
										{ id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 10 }] } },
										{ id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 11 }] } }
									],
									pageInfo: { hasNextPage: false, endCursor: null }
								}
							}
						}
					}
				});
			}
		});
		const { github } = await client(api);
		await github.resolveThread(11);
		const mutation = requests.at(-1)!.body as { variables: { threadId: string } };
		expect(mutation.variables.threadId).toBe('T2');
	});

	test('returns the pre-signed archive URL GitHub redirects to', async () => {
		const api = serve({
			'GET /repos/acme/app/tarball/h': () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://codeload.github.test/x.tgz' }
				})
		});
		const { github } = await client(api);
		expect(await github.getArchiveUrl('h')).toBe('https://codeload.github.test/x.tgz');
	});

	test('reports failed checks only', async () => {
		const api = serve({
			'GET /repos/acme/app/commits/h/check-runs': () =>
				Response.json({
					check_runs: [
						{ name: 'test', conclusion: 'failure', html_url: 'u1', output: { summary: 'boom' } },
						{ name: 'lint', conclusion: 'success', html_url: 'u2' }
					]
				})
		});
		const { github } = await client(api);
		expect(await github.listFailedChecks('h')).toEqual([
			{ name: 'test', conclusion: 'failure', url: 'u1', summary: 'boom' }
		]);
	});

	test('maps check runs to the API shape', async () => {
		const api = serve({
			'POST /repos/acme/app/check-runs': () => Response.json({ id: 3 }),
			'PATCH /repos/acme/app/check-runs/3': () => Response.json({ id: 3 })
		});
		const { github } = await client(api);
		await github.createCheckRun({ name: 'Hansi', headSha: 'h', status: 'in_progress' });
		await github.updateCheckRun(3, { status: 'completed', conclusion: 'success', title: 'Tier S' });
		expect(requests.map((r) => r.body)).toEqual([
			{ name: 'Hansi', head_sha: 'h', status: 'in_progress' },
			{ status: 'completed', conclusion: 'success', output: { title: 'Tier S', summary: 'Tier S' } }
		]);
	});

	test('lists comments with who posted them', async () => {
		const app = { login: 'hansi[bot]', type: 'Bot' };
		const api = serve({
			'GET /repos/acme/app/issues/7/comments': () =>
				Response.json([{ id: 1, body: 'hi', user: app, html_url: 'u' }]),
			'GET /repos/acme/app/pulls/7/comments': () =>
				Response.json([
					{
						id: 2,
						pull_request_review_id: 9,
						path: 'a.ts',
						line: 3,
						body: 'b',
						user: { login: 'octocat', type: 'User' },
						in_reply_to_id: 1,
						html_url: 'v',
						pull_request_url: 'p'
					}
				])
		});
		const { github } = await client(api);
		expect(await github.listIssueComments(7)).toEqual([
			{ id: 1, body: 'hi', author: 'hansi[bot]', bot: true, url: 'u' }
		]);
		expect(await github.listReviewComments(7)).toEqual([
			{
				id: 2,
				reviewId: 9,
				path: 'a.ts',
				line: 3,
				body: 'b',
				author: 'octocat',
				bot: false,
				inReplyToId: 1,
				url: 'v'
			}
		]);
	});

	test('lists reviews', async () => {
		const api = serve({
			'GET /repos/acme/app/pulls/7/reviews': () =>
				Response.json([
					{ id: 5, body: null, commit_id: 'h', html_url: 'u', user: { login: 'a', type: 'User' } },
					{
						id: 6,
						body: 'b',
						commit_id: 'h',
						html_url: 'v',
						user: { login: 'x[bot]', type: 'Bot' }
					}
				])
		});
		const { github } = await client(api);
		expect(await github.listReviews(7)).toEqual([
			{ id: 5, body: '', commitId: 'h', url: 'u', bot: false },
			{ id: 6, body: 'b', commitId: 'h', url: 'v', bot: true }
		]);
	});

	test('finds the GraphQL endpoint of GitHub Enterprise Server', async () => {
		const api = serve({
			'GET /api/v3/repos/acme/app/pulls/comments/11': () =>
				Response.json({
					id: 11,
					pull_request_url: 'https://ghe.test/api/v3/repos/acme/app/pulls/7'
				}),
			'POST /api/graphql': () =>
				Response.json({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [
										{ id: 'T1', isResolved: true, comments: { nodes: [{ databaseId: 11 }] } }
									],
									pageInfo: { hasNextPage: false, endCursor: null }
								}
							}
						}
					}
				})
		});
		const { github } = await client(`${api}/api/v3`);
		await github.resolveThread(11);
		expect(requests.map((r) => r.path)).toEqual([
			'/api/v3/repos/acme/app/pulls/comments/11',
			'/api/graphql'
		]);
	});

	test('throws GitHubError with the status on failure', async () => {
		const api = serve({});
		const { github } = await client(api);
		const error = await github.getPullRequest(1).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubError);
		expect((error as GitHubError).status).toBe(404);
	});
});
