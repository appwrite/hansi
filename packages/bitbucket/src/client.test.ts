import { afterEach, describe, expect, test } from 'bun:test';
import { isUnprocessable } from '@hansi/engine';
import { InstallationBitbucketClientFactory, type InstallationTokens } from './client';

// The client against a local fake of Bitbucket's API. Each test serves only the routes it needs;
// any other request answers 404 in Bitbucket's error shape.

interface Seen {
	method: string;
	path: string;
	query: URLSearchParams;
	auth: string | null;
	body: unknown;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';
const seen: Seen[] = [];

type Route = (request: Seen) => Response | Promise<Response>;

const REPO = '/2.0/repositories/acme/%7Brepo-uuid%7D';
const PR = `${REPO}/pullrequests/7`;

function serve(routes: Record<string, Route>): string {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			const entry: Seen = {
				method: request.method,
				path: url.pathname,
				query: url.searchParams,
				auth: request.headers.get('authorization'),
				body: text ? JSON.parse(text) : undefined
			};
			// The repository read when connecting is left out, so each test sees only its own calls.
			if (!(request.method === 'GET' && url.pathname === REPO)) seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			return route
				? route(entry)
				: Response.json({ type: 'error', error: { message: 'Not found' } }, { status: 404 });
		}
	});
	origin = `http://localhost:${server.port}`;
	return `${origin}/2.0`;
}

afterEach(async () => {
	await server?.stop(true);
	seen.length = 0;
});

const APP = { id: '{bot-uuid}', slug: 'hansi' };

const source: InstallationTokens = {
	async get() {
		return { token: 'bbt_1', expiresAt: new Date(Date.now() + 3_600_000), app: APP };
	}
};

const repository = {
	projectId: 'project1',
	repositoryId: 'repo1',
	provider: 'bitbucket' as const,
	providerRepositoryId: '{repo-uuid}',
	owner: 'acme',
	name: 'rocket'
};

async function connect(routes: Record<string, Route>) {
	const apiUrl = serve({
		[`GET ${REPO}`]: () =>
			Response.json({
				full_name: 'acme/rocket',
				links: {
					html: { href: 'https://bitbucket.org/acme/rocket' },
					clone: [
						{ name: 'https', href: 'https://someone@bitbucket.org/acme/rocket.git' },
						{ name: 'ssh', href: 'git@bitbucket.org:acme/rocket.git' }
					]
				}
			}),
		...routes
	});
	return new InstallationBitbucketClientFactory(source, { apiUrl }).forRepository(repository);
}

const bot = { uuid: APP.id, nickname: 'hansi-bot', type: 'app_user' };
const ada = { uuid: '{ada}', nickname: 'ada', type: 'user' };

function pullRequest(overrides: Record<string, unknown> = {}) {
	return {
		id: 7,
		title: 'Fix',
		description: 'Body',
		author: ada,
		state: 'OPEN',
		draft: false,
		source: {
			branch: { name: 'fix/login' },
			commit: { hash: 'aaaaaaaaaaaa' },
			repository: { full_name: 'acme/rocket' }
		},
		destination: {
			branch: { name: 'main' },
			commit: { hash: 'bbbbbbbbbbbb' },
			repository: { full_name: 'acme/rocket' }
		},
		participants: [],
		...overrides
	};
}

describe('BitbucketClient', () => {
	test('reads a pull request with whole commits, and signs git in as x-token-auth', async () => {
		const { github, filesUrl } = await connect({
			[`GET ${PR}`]: () => Response.json(pullRequest()),
			[`GET ${REPO}/commit/aaaaaaaaaaaa`]: () => Response.json({ hash: 'a'.repeat(40) }),
			[`GET ${REPO}/commit/bbbbbbbbbbbb`]: () => Response.json({ hash: 'b'.repeat(40) })
		});

		const pr = await github.getPullRequest(7);

		expect(filesUrl).toBe('https://bitbucket.org/acme/rocket/src');
		expect(pr).toMatchObject({
			number: 7,
			author: 'ada',
			state: 'open',
			merged: false,
			baseRef: 'main',
			baseSha: 'b'.repeat(40),
			headSha: 'a'.repeat(40),
			headRef: 'refs/heads/fix/login',
			cloneUrl: 'https://bitbucket.org/acme/rocket.git'
		});
		expect(await github.getInstallationToken()).toEqual({
			username: 'x-token-auth',
			token: 'bbt_1'
		});
		expect(seen[0]?.auth).toBe('Bearer bbt_1');
	});

	test('refuses a pull request from a fork, whose head it cannot fetch', async () => {
		const { github } = await connect({
			[`GET ${PR}`]: () =>
				Response.json(
					pullRequest({
						source: {
							branch: { name: 'x' },
							commit: { hash: 'a'.repeat(40) },
							repository: { full_name: 'mallory/rocket' }
						}
					})
				)
		});

		await expect(github.getPullRequest(7)).rejects.toThrow('fork mallory/rocket');
	});

	test('posts inline comments, then the body, then the verdict', async () => {
		let id = 0;
		const { github } = await connect({
			[`POST ${PR}/comments`]: () => Response.json({ id: ++id }),
			[`POST ${PR}/request-changes`]: () => Response.json({})
		});

		const review = await github.createReview({
			pullNumber: 7,
			commitId: 'h',
			body: 'Blocking',
			event: 'REQUEST_CHANGES',
			comments: [{ path: 'a.ts', line: 4, startLine: 2, body: 'bug' }]
		});

		expect(review).toEqual({ id: '2' });
		expect(seen.map((s) => [s.path, s.body])).toEqual([
			[`${PR}/comments`, { content: { raw: 'bug' }, inline: { path: 'a.ts', to: 4 } }],
			[
				`${PR}/comments`,
				{ content: { raw: 'Blocking\n\n[//]: # (appwrite-hansi-verdict:REQUEST_CHANGES)' } }
			],
			[`${PR}/request-changes`, undefined]
		]);
		expect(await github.listReviewComments(7, '2')).toEqual([
			{ id: '1', path: 'a.ts', line: 4, body: 'bug' }
		]);
	});

	test('takes back the comments it posted when Bitbucket refuses one', async () => {
		let id = 0;
		const { github } = await connect({
			[`POST ${PR}/comments`]: () =>
				++id === 1
					? Response.json({ id: 1 })
					: Response.json({ type: 'error', error: { message: 'bad line' } }, { status: 400 }),
			[`DELETE ${PR}/comments/1`]: () => new Response(null, { status: 204 })
		});

		const error = await github
			.createReview({
				pullNumber: 7,
				commitId: 'h',
				body: 'x',
				event: 'COMMENT',
				comments: [
					{ path: 'a.ts', line: 1, body: 'one' },
					{ path: 'a.ts', line: 900, body: 'two' }
				]
			})
			.catch((e: unknown) => e);

		expect(isUnprocessable(error)).toBe(true);
		expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: `${PR}/comments/1` });
	});

	test('withdraws its change request only for a review the caller owns', async () => {
		const comments = (body: string) => () =>
			Response.json({
				values: [
					{
						id: 1,
						content: { raw: `${body}\n\n[//]: # (appwrite-hansi-verdict:REQUEST_CHANGES)` },
						user: bot
					},
					{ id: 2, content: { raw: 'later' }, user: ada }
				]
			});
		const routes = {
			[`GET ${PR}`]: () =>
				Response.json(pullRequest({ participants: [{ user: bot, state: 'changes_requested' }] })),
			[`DELETE ${PR}/request-changes`]: () => new Response(null, { status: 204 })
		};

		const theirs = await connect({ ...routes, [`GET ${PR}/comments`]: comments('theirs') });
		expect(
			await theirs.github.dismissChangeRequests(7, {
				botLogin: 'hansi[bot]',
				message: 'fixed',
				only: (body) => body.startsWith('mine')
			})
		).toBe(0);
		await server?.stop(true);

		const mine = await connect({ ...routes, [`GET ${PR}/comments`]: comments('mine') });
		expect(
			await mine.github.dismissChangeRequests(7, {
				botLogin: 'hansi[bot]',
				message: 'fixed',
				only: (body) => body.startsWith('mine')
			})
		).toBe(1);
		expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: `${PR}/request-changes` });
	});

	test('follows next links and keys threads by their first comment', async () => {
		const { github } = await connect({
			[`GET ${PR}/comments`]: (request) =>
				request.query.get('page') === '2'
					? Response.json({
							values: [
								{
									id: 3,
									content: { raw: 'fixed' },
									user: ada,
									inline: { path: 'a.ts', to: 4 },
									parent: { id: 1 }
								},
								{ id: 4, content: { raw: 'gone' }, user: ada, deleted: true }
							]
						})
					: Response.json({
							values: [
								{
									id: 1,
									content: { raw: 'finding' },
									user: bot,
									inline: { path: 'a.ts', to: 4 },
									resolution: { user: ada }
								},
								{ id: 2, content: { raw: 'hello' }, user: ada }
							],
							next: `${origin}${PR}/comments?page=2`
						})
		});

		expect(await github.listReviewThreads(7)).toEqual([
			{ id: '1', isResolved: true, resolvedBy: 'ada', rootCommentId: '1' }
		]);
		expect(await github.getReviewThread(7, '1')).toEqual([
			{ id: '1', author: 'hansi[bot]', body: 'finding', isBot: true, path: 'a.ts', line: 4 },
			{ id: '3', author: 'ada', body: 'fixed', isBot: false, path: 'a.ts', line: 4 }
		]);
		expect(await github.getRecentIssueComments(7)).toEqual([
			{ id: '2', author: 'ada', body: 'hello', isBot: false }
		]);
	});

	test('the check run is a build status under its own key, left out of failed checks', async () => {
		const { github } = await connect({
			[`POST ${REPO}/commit/abc/statuses/build`]: () => Response.json({}),
			[`GET ${REPO}/commit/abc/statuses`]: () =>
				Response.json({
					values: [
						{
							key: 'ci',
							state: 'FAILED',
							name: 'Pipeline',
							description: 'tests failed',
							url: 'https://ci/1'
						},
						{ key: 'appwrite-hansi-0123', state: 'FAILED', name: 'Hansi' },
						{ key: 'lint', state: 'SUCCESSFUL' }
					]
				})
		});

		const id = await github.startCheckRun({ headSha: 'abc', name: 'Hansi', externalId: 'repo1' });
		await github.completeCheckRun(id, { conclusion: 'success', title: 'Tier 1', summary: '' });

		const [start, done] = seen.map((s) => s.body as { key: string });
		expect(start).toMatchObject({
			state: 'INPROGRESS',
			name: 'Hansi (repo1)',
			url: 'https://bitbucket.org/acme/rocket'
		});
		expect(start!.key).toStartWith('appwrite-hansi-');
		expect(start!.key.length).toBeLessThanOrEqual(40);
		expect(done).toMatchObject({ key: start!.key, state: 'SUCCESSFUL', description: 'Tier 1' });
		expect(await github.getFailedChecks('abc', APP.id)).toEqual([
			{
				name: 'Pipeline',
				conclusion: 'failure',
				output: 'tests failed\n\nhttps://ci/1',
				annotations: []
			}
		]);
	});

	test('splits the pull request diff into patches and reads files raw', async () => {
		const { github } = await connect({
			[`GET ${PR}/diff`]: () =>
				new Response('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'),
			[`GET ${REPO}/src/base/docs/a%20b.md`]: () => new Response('hello')
		});

		expect(await github.listPullRequestPatches(7)).toEqual([
			{ path: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }
		]);
		expect(await github.getFileContent('docs/a b.md', 'base')).toBe('hello');
		expect(await github.getFileContent('missing.md', 'base')).toBeNull();
	});

	test('write access needs a user it has seen and a write permission', async () => {
		const { github } = await connect({
			[`GET ${PR}`]: () => Response.json(pullRequest()),
			[`GET ${REPO}/commit/aaaaaaaaaaaa`]: () => Response.json({ hash: 'a'.repeat(40) }),
			[`GET ${REPO}/commit/bbbbbbbbbbbb`]: () => Response.json({ hash: 'b'.repeat(40) }),
			[`GET ${REPO}/permissions-config/users/%7Bada%7D`]: () =>
				Response.json({ permission: 'write' })
		});

		expect(await github.hasWriteAccess('ada')).toBe(false);
		await github.getPullRequest(7);
		expect(await github.hasWriteAccess('ada')).toBe(true);
	});
});
