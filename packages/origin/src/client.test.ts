import { afterEach, describe, expect, test } from 'bun:test';
import { isUnprocessable } from '@hansi/engine';
import { InstallationOriginClientFactory, type InstallationTokens } from './client';

// The client against a local fake of Origin's API. Each test serves only the routes it needs; any
// other request answers 404 in Origin's error shape.

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
				: Response.json({ code: 5, message: 'not found', details: [] }, { status: 404 });
		}
	});
	return `http://localhost:${server.port}/v1/origin`;
}

afterEach(async () => {
	await server?.stop(true);
	seen.length = 0;
});

const APP = { id: 'app_hansi', slug: 'hansi' };

function tokens(expiresInMs = 10 * 60_000) {
	let minted = 0;
	const source: InstallationTokens = {
		async get() {
			minted++;
			return { token: `oit_${minted}`, expiresAt: new Date(Date.now() + expiresInMs), app: APP };
		}
	};
	return { source, minted: () => minted };
}

const repository = {
	projectId: 'project1',
	repositoryId: 'repo1',
	provider: 'origin' as const,
	providerRepositoryId: 'repo_01',
	owner: 'acme',
	name: 'rocket'
};
const REPO = '/v1/origin/repos/_/repo_01';

async function connect(routes: Record<string, Route>, source = tokens().source) {
	const apiUrl = serve({
		[`GET ${REPO}`]: () =>
			Response.json({
				cloneUrl: 'https://origin.cursor.com/acme/rocket.git',
				webUrl: 'https://cursor.com/codebase/acme/rocket'
			}),
		...routes
	});
	return new InstallationOriginClientFactory(source, { apiUrl }).forRepository(repository);
}

const own = { app: { id: APP.id, displayName: 'Hansi' } };
const ada = { user: { id: 'user_ada', handle: 'ada' } };

function comment(
	id: string,
	thread: { id: string; path?: string; startLine?: number; endLine?: number; resolvedAt?: string },
	author: object,
	body: string
) {
	return {
		id,
		thread: { path: '', startLine: 0, endLine: 0, ...thread },
		author,
		body,
		createdAt: '2026-11-17T10:00:00Z'
	};
}

describe('InstallationOriginClientFactory', () => {
	test('acts as the app the token is for, addressing the repository by its id', async () => {
		const { github, app, webUrl } = await connect({
			[`GET ${REPO}`]: () =>
				Response.json({
					cloneUrl: 'https://origin.cursor.com/acme/rocket.git',
					webUrl: 'https://cursor.com/codebase/acme/rocket'
				}),
			[`GET ${REPO}/pulls/7`]: () =>
				Response.json({
					number: '7',
					title: 'Fix',
					body: '',
					author: ada,
					draft: false,
					state: 'open',
					merged: false,
					head: { ref: 'fix/login', sha: 'h'.repeat(40) },
					base: { ref: 'refs/heads/main', sha: 'b'.repeat(40) }
				})
		});

		const pr = await github.getPullRequest(7);

		expect(app).toEqual(APP);
		expect(webUrl).toBe('https://cursor.com/codebase/acme/rocket');
		expect(pr).toMatchObject({
			number: 7,
			author: 'ada',
			authorAssociation: '',
			baseRef: 'main',
			headRef: 'refs/heads/fix/login',
			cloneUrl: 'https://origin.cursor.com/acme/rocket.git'
		});
		expect(seen.every((r) => r.auth === 'Bearer oit_1')).toBe(true);
		expect(await github.getInstallationToken()).toBe('oit_1');
	});

	test('mints a new token when the current one is about to expire', async () => {
		const source = tokens(30_000);
		const { github } = await connect({}, source.source);

		const before = source.minted();
		await github.getInstallationToken();

		expect(source.minted()).toBe(before + 1);
	});
});

describe('OriginClient', () => {
	test('trusts an author by their repository permission, read by user id', async () => {
		const permissions: Record<string, string> = { user_ada: 'write', user_bob: 'read' };
		const pull = (author: object) => () =>
			Response.json({
				number: '1',
				title: '',
				body: '',
				author,
				draft: false,
				state: 'open',
				merged: false,
				head: { ref: 'x', sha: 'h' },
				base: { ref: 'main', sha: 'b' }
			});
		const { github } = await connect({
			[`GET ${REPO}`]: () => Response.json({ cloneUrl: '', webUrl: '' }),
			[`GET ${REPO}/pulls/1`]: pull(ada),
			[`GET ${REPO}/pulls/2`]: pull({ user: { id: 'user_bob', handle: 'bob' } }),
			[`GET ${REPO}/collaborators/user_ada/permission`]: () =>
				Response.json({ permission: permissions.user_ada }),
			[`GET ${REPO}/collaborators/user_bob/permission`]: () =>
				Response.json({ permission: permissions.user_bob })
		});

		const trusted = await github.isTrustedAuthor(await github.getPullRequest(1));
		const untrusted = await github.isTrustedAuthor(await github.getPullRequest(2));

		expect(trusted).toBe(true);
		expect(untrusted).toBe(false);
		// Someone the client never saw has no id to look up.
		expect(await github.hasWriteAccess('mallory')).toBe(false);
	});

	test('posts a review with inline anchors and finds the threads it opened', async () => {
		let since = '';
		const { github } = await connect({
			[`POST ${REPO}/pulls/7/reviews`]: () => Response.json({ id: 'rev_1' }),
			[`GET ${REPO}/pulls/7/comments`]: (request) => {
				since = request.query.get('since') ?? '';
				return Response.json({
					comments: [
						comment('cmt_1', { id: 'cth_1', path: 'a.ts', startLine: 3, endLine: 5 }, own, 'one'),
						comment('cmt_2', { id: 'cth_1', path: 'a.ts', startLine: 3, endLine: 5 }, ada, 're'),
						comment('cmt_3', { id: 'cth_2', path: 'b.ts', startLine: 9 }, own, 'two'),
						comment('cmt_4', { id: 'cth_3', path: 'c.ts', startLine: 1 }, ada, 'not ours'),
						comment('cmt_5', { id: 'cth_4' }, own, 'summary')
					],
					nextPageToken: ''
				});
			}
		});

		const review = await github.createReview({
			pullNumber: 7,
			commitId: 'h',
			body: 'Looks good',
			event: 'REQUEST_CHANGES',
			comments: [
				{ path: 'a.ts', line: 5, startLine: 3, body: 'one' },
				{ path: 'b.ts', line: 9, body: 'two' }
			]
		});
		const posted = await github.listReviewComments(7, review.id);

		expect(review).toEqual({ id: 'rev_1' });
		expect(seen[0]?.body).toEqual({
			verdict: 'request_changes',
			body: 'Looks good',
			comments: [
				{ body: 'one', inline: { path: 'a.ts', side: 'right', startLine: 3, endLine: 5 } },
				{ body: 'two', inline: { path: 'b.ts', side: 'right', startLine: 9 } }
			]
		});
		expect(since).not.toBe('');
		expect(posted).toEqual([
			{ id: 'cth_1', path: 'a.ts', line: 5, body: 'one' },
			{ id: 'cth_2', path: 'b.ts', line: 9, body: 'two' }
		]);
	});

	test('opens the threads past the review limit on their own', async () => {
		const { github } = await connect({
			[`POST ${REPO}/pulls/7/reviews`]: () => Response.json({ id: 'rev_1' }),
			[`POST ${REPO}/pulls/7/comments`]: () =>
				Response.json(comment('cmt_x', { id: 'cth_x' }, own, ''))
		});
		const comments = Array.from({ length: 52 }, (_, i) => ({
			path: 'a.ts',
			line: i + 1,
			body: `finding ${i}`
		}));

		await github.createReview({
			pullNumber: 7,
			commitId: 'h',
			body: '',
			event: 'COMMENT',
			comments
		});

		const reviewBody = seen[0]?.body as { comments: unknown[] };
		expect(reviewBody.comments).toHaveLength(50);
		expect(seen.slice(1).map((r) => (r.body as { body: string }).body)).toEqual([
			'finding 50',
			'finding 51'
		]);
	});

	test('an anchor Origin rejects reads as unprocessable, like GitHub 422', async () => {
		const { github } = await connect({
			[`POST ${REPO}/pulls/7/comments`]: () =>
				Response.json({ code: 9, message: 'path is not in the diff' }, { status: 400 })
		});

		const error = await github
			.createFileComment({ pullNumber: 7, commitId: 'h', path: 'gone.ts', body: 'x' })
			.catch((e: unknown) => e);

		expect(isUnprocessable(error)).toBe(true);
	});

	test('a file comment opens a thread on the file and returns the thread', async () => {
		const { github } = await connect({
			[`POST ${REPO}/pulls/7/comments`]: () =>
				Response.json(comment('cmt_9', { id: 'cth_9', path: 'a.ts' }, own, 'x'))
		});

		const id = await github.createFileComment({
			pullNumber: 7,
			commitId: 'h',
			path: 'a.ts',
			body: 'x'
		});

		expect(id).toBe('cth_9');
		expect(seen[0]?.body).toEqual({ body: 'x', file: { path: 'a.ts' } });
	});

	test('keeps one summary comment: found by its marker, created once, then edited', async () => {
		const comments: ReturnType<typeof comment>[] = [];
		const { github } = await connect({
			[`GET ${REPO}`]: () =>
				Response.json({ cloneUrl: '', webUrl: 'https://cursor.com/codebase/acme/rocket' }),
			[`GET ${REPO}/pulls/7/comments`]: () => Response.json({ comments, nextPageToken: '' }),
			[`POST ${REPO}/pulls/7/comments`]: (request) => {
				const created = comment(
					'cmt_s',
					{ id: 'cth_s' },
					own,
					(request.body as { body: string }).body
				);
				comments.push(created);
				return Response.json(created);
			},
			[`PATCH ${REPO}/pulls/comments/cmt_s`]: (request) => {
				comments[0]!.body = (request.body as { body: string }).body;
				return Response.json(comments[0]);
			}
		});

		const first = await github.upsertMarkedComment(7, '<!-- m -->', '<!-- m --> v1');
		const second = await github.upsertMarkedComment(7, '<!-- m -->', '<!-- m --> v2');

		expect(first).toEqual({ id: 'cmt_s', url: 'https://cursor.com/codebase/acme/rocket/pull/7' });
		expect(second.id).toBe('cmt_s');
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toBe('<!-- m --> v2');
	});

	test('reads a thread by its id, replies in it, and resolves it', async () => {
		const { github } = await connect({
			[`GET ${REPO}/pulls/7/comments`]: (request) => {
				expect(request.query.getAll('threadIds')).toEqual(['cth_1']);
				return Response.json({
					comments: [
						comment('cmt_1', { id: 'cth_1', path: 'a.ts', startLine: 4 }, own, 'finding'),
						comment('cmt_2', { id: 'cth_1', path: 'a.ts', startLine: 4 }, ada, '@hansi why?')
					],
					nextPageToken: ''
				});
			},
			[`POST ${REPO}/pulls/7/comments`]: () =>
				Response.json(comment('cmt_3', { id: 'cth_1' }, own, '')),
			[`PATCH ${REPO}/pulls/threads/cth_1`]: () => Response.json({ id: 'cth_1' })
		});

		const thread = await github.getReviewThread(7, 'cth_1');
		await github.replyToReviewComment(7, 'cth_1', 'Because.');
		const resolved = await github.resolveReviewThreads(7, ['cth_1']);

		expect(thread).toEqual([
			{ id: 'cmt_1', author: 'hansi[bot]', body: 'finding', isBot: true, path: 'a.ts', line: 4 },
			{ id: 'cmt_2', author: 'ada', body: '@hansi why?', isBot: false, path: 'a.ts', line: 4 }
		]);
		expect(seen[1]?.body).toEqual({ body: 'Because.', threadId: 'cth_1' });
		expect(seen[2]?.body).toEqual({ resolved: true });
		expect(resolved).toBe(1);
	});

	test('lists review threads by their first comment, following page tokens', async () => {
		const { github } = await connect({
			[`GET ${REPO}/pulls/7/comments`]: (request) =>
				request.query.get('pageToken') === 'next'
					? Response.json({
							comments: [
								comment(
									'cmt_3',
									{ id: 'cth_2', path: 'b.ts', resolvedAt: '2026-11-17T11:00:00Z' },
									own,
									'b'
								)
							],
							nextPageToken: ''
						})
					: Response.json({
							comments: [
								comment('cmt_1', { id: 'cth_1', path: 'a.ts' }, own, 'a'),
								comment('cmt_2', { id: 'cth_1', path: 'a.ts' }, ada, 'reply')
							],
							nextPageToken: 'next'
						})
		});

		const threads = await github.listReviewThreads(7);

		expect(threads).toEqual([
			{ id: 'cth_1', isResolved: false, resolvedBy: null, rootCommentId: 'cth_1' },
			{ id: 'cth_2', isResolved: true, resolvedBy: null, rootCommentId: 'cth_2' }
		]);
	});

	test('reads the recent conversation up to a comment, leaving out review threads', async () => {
		const { github } = await connect({
			[`GET ${REPO}/pulls/7/comments`]: () =>
				Response.json({
					comments: [
						comment('cmt_1', { id: 'cth_1' }, ada, 'first'),
						comment('cmt_2', { id: 'cth_2', path: 'a.ts' }, own, 'inline'),
						comment(
							'cmt_3',
							{ id: 'cth_3' },
							{ serviceAccount: { id: 'sa_1', displayName: 'Cursor' } },
							'second'
						),
						comment('cmt_4', { id: 'cth_4' }, ada, 'later')
					],
					nextPageToken: ''
				})
		});

		const recent = await github.getRecentIssueComments(7, 20, 'cmt_3');

		expect(recent).toEqual([
			{ id: 'cmt_1', author: 'ada', body: 'first', isBot: false },
			{ id: 'cmt_3', author: 'Cursor[bot]', body: 'second', isBot: true }
		]);
	});

	test('dismisses only its own standing change requests', async () => {
		const { github } = await connect({
			[`GET ${REPO}/pulls/7/reviews`]: () =>
				Response.json({
					reviews: [
						{ id: 'rev_1', author: own, verdict: 'request_changes', body: 'old' },
						{ id: 'rev_2', author: own, verdict: 'request_changes', body: 'gone', dismissal: {} },
						{ id: 'rev_3', author: ada, verdict: 'request_changes', body: 'theirs' },
						{ id: 'rev_4', author: own, verdict: 'approve', body: 'ok' }
					],
					nextPageToken: ''
				}),
			[`PUT ${REPO}/pulls/7/reviews/rev_1/dismissals`]: () => Response.json({})
		});

		const dismissed = await github.dismissChangeRequests(7, {
			botLogin: 'hansi[bot]',
			message: 'Fixed'
		});

		expect(dismissed).toBe(1);
		expect(seen.at(-1)).toMatchObject({
			method: 'PUT',
			path: `${REPO}/pulls/7/reviews/rev_1/dismissals`,
			body: { message: 'Fixed' }
		});
	});

	test('upserts one check run by its key from start to completion', async () => {
		const { github } = await connect({
			[`POST ${REPO}/check-runs`]: () =>
				Response.json({ checkSuite: { id: 'cs_1' }, checkRun: { id: 'cr_1' } })
		});

		const id = await github.startCheckRun({
			headSha: 'h',
			name: 'Hansi',
			externalId: 'repo1',
			output: { title: 'Reviewing', summary: '' }
		});
		await github.updateCheckRun(id, { title: 'Halfway', summary: '' });
		await github.completeCheckRun(id, { conclusion: 'success', title: 'Done', summary: 'ok' });

		const runs = seen.map((r) => (r.body as { checkRun: Record<string, unknown> }).checkRun);
		expect(id).toBe('cr_1');
		expect(runs.map((run) => [run.key, run.externalId, run.status])).toEqual([
			['hansi-repo1', 'repo1', 'in_progress'],
			['hansi-repo1', 'repo1', 'in_progress'],
			['hansi-repo1', 'repo1', 'completed']
		]);
		expect(runs[2]).toMatchObject({
			conclusion: 'success',
			output: { title: 'Done', summary: 'ok' }
		});
		const times = runs.map((run) => Date.parse(run.externalUpdatedAt as string));
		expect(times[0]! < times[1]! && times[1]! < times[2]!).toBe(true);
	});

	test('reads failed checks of other apps on a commit', async () => {
		const { github } = await connect({
			[`GET ${REPO}/commits/h/check-runs`]: () =>
				Response.json({
					checkRuns: [
						{
							id: '1',
							name: 'CI',
							status: 'completed',
							conclusion: 'failure',
							actor: { app: { id: 'app_ci' } },
							output: { title: 'Tests', summary: '2 failed' }
						},
						{ id: '2', name: 'Hansi', status: 'completed', conclusion: 'failure', actor: own },
						{
							id: '3',
							name: 'Lint',
							status: 'completed',
							conclusion: 'success',
							actor: { app: { id: 'app_ci' } }
						}
					],
					nextPageToken: ''
				})
		});

		const failed = await github.getFailedChecks('h', APP.id);

		expect(failed).toEqual([
			{ name: 'CI', conclusion: 'failure', output: 'Tests\n\n2 failed', annotations: [] }
		]);
	});

	test('reads a file at a ref, and a missing one as null', async () => {
		const { github } = await connect({
			[`GET ${REPO}/contents`]: (request) =>
				request.query.get('path') === '.hansi.yml'
					? Response.json({
							type: 'file',
							encoding: 'base64',
							content: Buffer.from('strength: expert\n').toString('base64')
						})
					: Response.json({ code: 5, message: 'not found' }, { status: 404 })
		});

		expect(await github.getFileContent('.hansi.yml', 'main')).toBe('strength: expert\n');
		expect(seen[0]?.query.get('ref')).toBe('main');
		expect(await github.getFileContent('missing.yml', 'main')).toBeNull();
	});

	test('waits out a rate limit and tries again', async () => {
		let calls = 0;
		const { github } = await connect({
			[`POST ${REPO}/pulls/comments/cmt_1/reactions`]: () =>
				++calls === 1
					? Response.json(
							{ code: 8, message: 'slow down' },
							{ status: 429, headers: { 'retry-after': '0' } }
						)
					: Response.json({})
		});

		await github.acknowledgeComment({ id: 'cmt_1', kind: 'issue' });

		expect(calls).toBe(2);
		expect(seen.at(-1)?.body).toEqual({ emoji: '👀' });
	});
});
