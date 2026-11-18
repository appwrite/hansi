import { afterEach, describe, expect, test } from 'bun:test';
import { isUnprocessable } from '@hansi/engine';
import { InstallationGiteaClientFactory, type InstallationTokens } from './client';

// The client against a local fake of Gitea's API. Each test serves only the routes it needs; any
// other request answers 404 in Gitea's error shape.

interface Seen {
	method: string;
	path: string;
	query: URLSearchParams;
	auth: string | null;
	body: unknown;
}

let server: ReturnType<typeof Bun.serve> | undefined;
const seen: Seen[] = [];

type Route = (request: Seen) => Response | Promise<Response>;

const BY_ID = '/api/v1/repositories/77';
const REPO = '/api/v1/repos/acme/rocket';
const PULL = `${REPO}/pulls/7`;

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
			if (!(request.method === 'GET' && url.pathname === BY_ID)) seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			return route ? route(entry) : Response.json({ message: 'not found' }, { status: 404 });
		}
	});
	return `http://localhost:${server.port}/api/v1`;
}

afterEach(async () => {
	await server?.stop(true);
	seen.length = 0;
});

const APP = { id: '900', slug: 'hansi' };

const source: InstallationTokens = {
	async get() {
		return { token: 'gt_1', expiresAt: new Date(Date.now() + 3_600_000), app: APP };
	}
};

// Renamed since it was linked: the id finds it under its new name.
const repository = {
	projectId: 'project1',
	repositoryId: 'repo1',
	provider: 'gitea' as const,
	providerRepositoryId: '77',
	owner: 'acme',
	name: 'old-name'
};

async function connect(routes: Record<string, Route>) {
	const apiUrl = serve({
		[`GET ${BY_ID}`]: () =>
			Response.json({
				name: 'rocket',
				owner: { id: 1, login: 'acme' },
				html_url: 'https://git.example.com/acme/rocket',
				clone_url: 'https://git.example.com/acme/rocket.git'
			}),
		...routes
	});
	return new InstallationGiteaClientFactory(source, { apiUrl }).forRepository(repository);
}

const bot = { id: 900, login: 'hansi-bot' };
const ada = { id: 1, login: 'ada' };

describe('GiteaClient', () => {
	test('finds the repository by id and reads a pull request at refs/pull', async () => {
		const { github, filesUrl } = await connect({
			[`GET ${PULL}`]: () =>
				Response.json({
					number: 7,
					title: 'Fix',
					body: 'Body',
					user: ada,
					state: 'open',
					merged: false,
					head: { sha: 'h'.repeat(40) },
					base: { ref: 'main', sha: 'b'.repeat(40) }
				})
		});

		const pr = await github.getPullRequest(7);

		expect(filesUrl).toBe('https://git.example.com/acme/rocket/src/commit');
		expect(pr).toMatchObject({
			number: 7,
			author: 'ada',
			draft: false,
			baseRef: 'main',
			headSha: 'h'.repeat(40),
			cloneUrl: 'https://git.example.com/acme/rocket.git'
		});
		expect(pr.headRef).toBeUndefined();
		expect(seen[0]?.auth).toBe('token gt_1');
		expect(await github.getInstallationToken()).toEqual({ username: 'hansi', token: 'gt_1' });
	});

	test('submits a review with its comments, each on its last line', async () => {
		const { github } = await connect({
			[`POST ${PULL}/reviews`]: () => Response.json({ id: 31 }),
			[`GET ${PULL}/reviews/31/comments`]: () =>
				Response.json([{ id: 5, body: 'bug', path: 'a.ts', position: 4, user: bot }])
		});

		const review = await github.createReview({
			pullNumber: 7,
			commitId: 'h',
			body: 'Blocking',
			event: 'REQUEST_CHANGES',
			comments: [{ path: 'a.ts', line: 4, startLine: 2, body: 'bug' }]
		});

		expect(review).toEqual({ id: '31' });
		expect(seen[0]?.body).toEqual({
			commit_id: 'h',
			event: 'REQUEST_CHANGES',
			body: 'Blocking',
			comments: [{ path: 'a.ts', new_position: 4, body: 'bug' }]
		});
		expect(await github.listReviewComments(7, '31')).toEqual([
			{ id: '5', path: 'a.ts', line: 4, body: 'bug' }
		]);
	});

	test('refuses a file comment the way it refuses a line off the diff', async () => {
		const { github } = await connect({});

		const error = await github
			.createFileComment({ pullNumber: 7, commitId: 'h', path: 'a.ts', body: 'x' })
			.catch((e: unknown) => e);

		expect(isUnprocessable(error)).toBe(true);
		expect(seen).toEqual([]);
	});

	test('threads are the comments on one line, resolved by whoever resolved them', async () => {
		const { github } = await connect({
			[`GET ${PULL}/reviews`]: () =>
				Response.json([
					{ id: 31, body: '', user: bot, state: 'COMMENT' },
					{ id: 32, body: '', user: ada, state: 'PENDING' }
				]),
			[`GET ${PULL}/reviews/31/comments`]: () =>
				Response.json([
					{
						id: 5,
						body: 'finding',
						path: 'a.ts',
						position: 4,
						user: bot,
						diff_hunk: '@@ -1 +1 @@'
					},
					{ id: 9, body: 'fixed', path: 'a.ts', position: 4, user: ada, resolver: ada },
					{ id: 6, body: 'other', path: 'b.ts', position: 1, user: bot }
				])
		});

		expect(await github.listReviewThreads(7)).toEqual([
			{ id: '5', isResolved: true, resolvedBy: 'ada', rootCommentId: '5' },
			{ id: '6', isResolved: false, resolvedBy: null, rootCommentId: '6' }
		]);
		expect(await github.getReviewThread(7, '5')).toEqual([
			{
				id: '5',
				author: 'hansi[bot]',
				body: 'finding',
				isBot: true,
				path: 'a.ts',
				line: 4,
				diffHunk: '@@ -1 +1 @@'
			},
			{ id: '9', author: 'ada', body: 'fixed', isBot: false, path: 'a.ts', line: 4 }
		]);
		expect(seen.some((s) => s.path === `${PULL}/reviews/32/comments`)).toBe(false);
	});

	test('dismisses only its own open change requests that the caller owns', async () => {
		const { github } = await connect({
			[`GET ${PULL}/reviews`]: () =>
				Response.json([
					{ id: 1, body: 'mine', user: bot, state: 'REQUEST_CHANGES' },
					{ id: 2, body: 'theirs', user: bot, state: 'REQUEST_CHANGES' },
					{ id: 3, body: 'mine', user: bot, state: 'REQUEST_CHANGES', dismissed: true },
					{ id: 4, body: 'mine', user: ada, state: 'REQUEST_CHANGES' }
				]),
			[`POST ${PULL}/reviews/1/dismissals`]: () => Response.json({})
		});

		const dismissed = await github.dismissChangeRequests(7, {
			botLogin: 'hansi[bot]',
			message: 'fixed',
			only: (body) => body === 'mine'
		});

		expect(dismissed).toBe(1);
		expect(seen.at(-1)).toMatchObject({
			path: `${PULL}/reviews/1/dismissals`,
			body: { message: 'fixed' }
		});
	});

	test('edits its marked comment, and reacts and replies on review comments', async () => {
		const { github } = await connect({
			[`GET ${REPO}/issues/7/comments`]: () =>
				Response.json([
					{ id: 1, body: '<!-- m --> by someone else', user: ada },
					{ id: 2, body: '<!-- m --> old', user: bot, html_url: 'https://git/c/2' }
				]),
			[`PATCH ${REPO}/issues/comments/2`]: () => Response.json({}),
			[`POST ${REPO}/issues/comments/5/reactions`]: () => Response.json({}),
			[`POST ${PULL}/comments/5/replies`]: () => Response.json({}),
			[`POST ${REPO}/pulls/comments/5/resolve`]: () => new Response(null, { status: 204 })
		});

		expect(await github.upsertMarkedComment(7, '<!-- m -->', '<!-- m --> new')).toEqual({
			id: '2',
			url: 'https://git/c/2'
		});
		await github.acknowledgeComment(7, { id: '5', kind: 'review' });
		await github.replyToReviewComment(7, '5', 'Done');
		expect(await github.resolveReviewThreads(7, ['5'])).toBe(1);

		expect(seen.slice(1).map((s) => [s.method, s.path, s.body])).toEqual([
			['PATCH', `${REPO}/issues/comments/2`, { body: '<!-- m --> new' }],
			['POST', `${REPO}/issues/comments/5/reactions`, { content: 'eyes' }],
			['POST', `${PULL}/comments/5/replies`, { body: 'Done' }],
			['POST', `${REPO}/pulls/comments/5/resolve`, undefined]
		]);
	});

	test('links issues the description closes, leaving out pull requests', async () => {
		const { github } = await connect({
			[`GET ${PULL}`]: () =>
				Response.json({ body: 'Fixes #3, closes #4 and mentions #5. Resolves: #3' }),
			[`GET ${REPO}/issues/3`]: () => Response.json({ number: 3, title: 'Bug', body: 'Broken' }),
			[`GET ${REPO}/issues/4`]: () =>
				Response.json({ number: 4, title: 'A pull request', body: '', pull_request: {} })
		});

		expect(await github.getLinkedIssues(7)).toEqual([{ number: 3, title: 'Bug', body: 'Broken' }]);
	});

	test('the check run is a commit status, left out of failed checks', async () => {
		const { github } = await connect({
			[`POST ${REPO}/statuses/abc`]: () => Response.json({}),
			[`GET ${REPO}/commits/abc/status`]: () =>
				Response.json({
					statuses: [
						{
							context: 'ci/test',
							status: 'failure',
							description: 'exit 1',
							target_url: 'https://ci/1',
							creator: ada
						},
						{ context: 'Hansi (repo1)', status: 'failure', creator: bot },
						{ context: 'ci/lint', status: 'success', creator: ada }
					]
				})
		});

		const id = await github.startCheckRun({
			headSha: 'abc',
			name: 'Hansi',
			externalId: 'repo1',
			detailsUrl: 'https://console/review'
		});
		await github.completeCheckRun(id, { conclusion: 'cancelled', title: 'Stopped', summary: '' });

		expect(seen.map((s) => s.body)).toEqual([
			{ state: 'pending', context: 'Hansi (repo1)', target_url: 'https://console/review' },
			{
				state: 'error',
				context: 'Hansi (repo1)',
				description: 'Stopped',
				target_url: 'https://console/review'
			}
		]);
		expect(await github.getFailedChecks('abc', APP.id)).toEqual([
			{ name: 'ci/test', conclusion: 'failure', output: 'exit 1\n\nhttps://ci/1', annotations: [] }
		]);
	});

	test('splits the pull request diff, reads files raw, and checks write access', async () => {
		const { github } = await connect({
			[`GET ${REPO}/pulls/7.diff`]: () =>
				new Response('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'),
			[`GET ${REPO}/raw/.hansi.yml`]: (request) => new Response(`ref ${request.query.get('ref')}`),
			[`GET ${REPO}/collaborators/ada/permission`]: () => Response.json({ permission: 'write' }),
			[`GET ${REPO}/collaborators/eve/permission`]: () => Response.json({ permission: 'read' })
		});

		expect(await github.listPullRequestPatches(7)).toEqual([
			{ path: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }
		]);
		expect(await github.getFileContent('.hansi.yml', 'base')).toBe('ref base');
		expect(await github.getFileContent('missing', 'base')).toBeNull();
		expect(await github.hasWriteAccess('ada')).toBe(true);
		expect(await github.hasWriteAccess('eve')).toBe(false);
		expect(await github.hasWriteAccess('nobody')).toBe(false);
	});
});
