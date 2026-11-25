import { afterEach, describe, expect, test } from 'bun:test';
import { isUnprocessable } from '@hansi/engine';
import { contextLines, InstallationGitLabClientFactory, type InstallationTokens } from './client';

// The client against a local fake of GitLab's API. Each test serves only the routes it needs; any
// other request answers 404 in GitLab's error shape.

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

const PROJECT = '/api/v4/projects/42';
const MR = `${PROJECT}/merge_requests/7`;

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
			// The project read when connecting is left out, so each test sees only its own calls.
			if (!(request.method === 'GET' && url.pathname === PROJECT)) seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			return route ? route(entry) : Response.json({ message: '404 Not found' }, { status: 404 });
		}
	});
	return `http://localhost:${server.port}/api/v4`;
}

afterEach(async () => {
	await server?.stop(true);
	seen.length = 0;
});

const APP = { id: '900', slug: 'hansi' };

const source: InstallationTokens = {
	async get() {
		return { token: 'glpat_1', expiresAt: new Date(Date.now() + 3_600_000), app: APP };
	}
};

const repository = {
	projectId: 'project1',
	repositoryId: 'repo1',
	provider: 'gitlab' as const,
	providerRepositoryId: '42',
	owner: 'acme/platform',
	name: 'rocket'
};

async function connect(routes: Record<string, Route>) {
	const apiUrl = serve({
		[`GET ${PROJECT}`]: () =>
			Response.json({
				id: 42,
				web_url: 'https://gitlab.example.com/acme/platform/rocket',
				http_url_to_repo: 'https://gitlab.example.com/acme/platform/rocket.git'
			}),
		...routes
	});
	return new InstallationGitLabClientFactory(source, { apiUrl }).forRepository(repository);
}

const bot = { id: 900, username: 'hansi-bot', bot: true };
const ada = { id: 1, username: 'ada' };

const PATCH = '@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+added\n tail\n';

describe('GitLabClient', () => {
	test('reads a merge request and signs git in as oauth2', async () => {
		const { github, filesUrl } = await connect({
			[`GET ${MR}`]: () =>
				Response.json({
					iid: 7,
					title: 'Fix',
					description: null,
					author: ada,
					draft: true,
					state: 'merged',
					target_branch: 'main',
					sha: 'h'.repeat(40),
					diff_refs: {
						base_sha: 'm'.repeat(40),
						start_sha: 'b'.repeat(40),
						head_sha: 'h'.repeat(40)
					},
					web_url: ''
				})
		});

		const pr = await github.getPullRequest(7);

		expect(filesUrl).toBe('https://gitlab.example.com/acme/platform/rocket/-/blob');
		expect(pr).toMatchObject({
			number: 7,
			body: '',
			author: 'ada',
			draft: true,
			state: 'closed',
			merged: true,
			baseRef: 'main',
			baseSha: 'b'.repeat(40),
			headSha: 'h'.repeat(40),
			headRef: 'refs/merge-requests/7/head',
			cloneUrl: 'https://gitlab.example.com/acme/platform/rocket.git'
		});
		expect(await github.getInstallationToken()).toEqual({ username: 'oauth2', token: 'glpat_1' });
		expect(seen[0]?.auth).toBe('Bearer glpat_1');
	});

	test('anchors comments on the reviewed version, then posts the body and approves', async () => {
		let discussion = 0;
		const { github } = await connect({
			[`GET ${MR}/versions`]: () =>
				Response.json([
					{ id: 2, head_commit_sha: 'new', base_commit_sha: 'base2', start_commit_sha: 'start2' },
					{ id: 1, head_commit_sha: 'old', base_commit_sha: 'base1', start_commit_sha: 'start1' }
				]),
			[`GET ${MR}/versions/1`]: () =>
				Response.json({ diffs: [{ old_path: 'src/was.ts', new_path: 'src/a.ts', diff: PATCH }] }),
			[`POST ${MR}/discussions`]: () => {
				discussion++;
				return Response.json({ id: `d${discussion}`, notes: [{ id: 100 + discussion }] });
			},
			[`POST ${MR}/notes`]: () => Response.json({ id: 555 }),
			[`POST ${MR}/approve`]: () => Response.json({})
		});

		const review = await github.createReview({
			pullNumber: 7,
			commitId: 'old',
			body: 'Looks good',
			event: 'APPROVE',
			comments: [
				{ path: 'src/a.ts', line: 12, body: 'added line' },
				{ path: 'src/a.ts', line: 13, startLine: 10, body: 'context line' }
			]
		});

		expect(review).toEqual({ id: '555' });
		const positions = seen
			.filter((s) => s.path === `${MR}/discussions`)
			.map((s) => (s.body as { position: Record<string, unknown> }).position);
		expect(positions[0]).toEqual({
			position_type: 'text',
			base_sha: 'base1',
			start_sha: 'start1',
			head_sha: 'old',
			new_path: 'src/a.ts',
			old_path: 'src/was.ts',
			new_line: 12
		});
		expect(positions[1]).toMatchObject({ new_line: 13, old_line: 12 });
		expect(seen.find((s) => s.path === `${MR}/approve`)?.body).toEqual({ sha: 'old' });
		expect(await github.listReviewComments(7, '555')).toEqual([
			{ id: 'd1', path: 'src/a.ts', line: 12, body: 'added line' },
			{ id: 'd2', path: 'src/a.ts', line: 13, body: 'context line' }
		]);
	});

	test('deletes the discussions it opened when GitLab refuses one, and says so', async () => {
		let discussion = 0;
		const { github } = await connect({
			[`GET ${MR}/versions`]: () => Response.json([]),
			[`GET ${MR}`]: () =>
				Response.json({ diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } }),
			[`GET ${MR}/diffs`]: () => Response.json([]),
			[`POST ${MR}/discussions`]: () => {
				discussion++;
				return discussion === 1
					? Response.json({ id: 'd1', notes: [{ id: 101 }] })
					: Response.json({ message: { line_code: ["can't be blank"] } }, { status: 400 });
			},
			[`DELETE ${MR}/notes/101`]: () => new Response(null, { status: 204 })
		});

		const error = await github
			.createReview({
				pullNumber: 7,
				commitId: 'h',
				body: 'x',
				event: 'COMMENT',
				comments: [
					{ path: 'a.ts', line: 1, body: 'one' },
					{ path: 'a.ts', line: 99, body: 'two' }
				]
			})
			.catch((e: unknown) => e);

		expect(isUnprocessable(error)).toBe(true);
		expect(seen.some((s) => s.method === 'DELETE' && s.path === `${MR}/notes/101`)).toBe(true);
		expect(seen.some((s) => s.path === `${MR}/notes` && s.method === 'POST')).toBe(false);
	});

	test('withdraws its approval to request changes, and tolerates having none', async () => {
		const { github } = await connect({
			[`POST ${MR}/notes`]: () => Response.json({ id: 1 }),
			[`POST ${MR}/unapprove`]: () => Response.json({ message: '404 Not Found' }, { status: 404 })
		});

		await github.createReview({
			pullNumber: 7,
			commitId: 'h',
			body: 'Blocking',
			event: 'REQUEST_CHANGES',
			comments: []
		});

		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			`POST ${MR}/notes`,
			`POST ${MR}/unapprove`
		]);
	});

	test('keys review threads by discussion, with who resolved them', async () => {
		const { github } = await connect({
			[`GET ${MR}/discussions`]: () =>
				Response.json([
					{
						id: 'd1',
						notes: [
							{
								id: 1,
								body: 'finding',
								author: bot,
								system: false,
								position: { new_path: 'a.ts', new_line: 3 },
								resolvable: true,
								resolved: true,
								resolved_by: ada
							}
						]
					},
					{ id: 'd2', notes: [{ id: 2, body: 'hi', author: ada, system: false, position: null }] }
				])
		});

		expect(await github.listReviewThreads(7)).toEqual([
			{ id: 'd1', isResolved: true, resolvedBy: 'ada', rootCommentId: 'd1' }
		]);
	});

	test('edits its marked conversation note in place', async () => {
		const { github } = await connect({
			[`GET ${MR}/notes`]: () =>
				Response.json([
					{ id: 1, body: 'status changed', author: ada, system: true },
					{ id: 2, body: '<!-- m --> old', author: bot, system: false },
					{
						id: 3,
						body: '<!-- m --> on the diff',
						author: bot,
						system: false,
						position: { new_path: 'a.ts' }
					}
				]),
			[`PUT ${MR}/notes/2`]: () => Response.json({})
		});

		const marked = await github.upsertMarkedComment(7, '<!-- m -->', '<!-- m --> new');

		expect(marked).toEqual({
			id: '2',
			url: 'https://gitlab.example.com/acme/platform/rocket/-/merge_requests/7#note_2'
		});
		expect(seen.at(-1)?.body).toEqual({ body: '<!-- m --> new' });
	});

	test('names the bot <slug>[bot] in a thread', async () => {
		const { github } = await connect({
			[`GET ${MR}/discussions/d1`]: () =>
				Response.json({
					id: 'd1',
					notes: [
						{
							id: 1,
							body: 'finding',
							author: bot,
							system: false,
							position: { new_path: 'a.ts', new_line: 4 }
						},
						{
							id: 2,
							body: 'why?',
							author: ada,
							system: false,
							position: { new_path: 'a.ts', new_line: 4 }
						}
					]
				})
		});

		expect(await github.getReviewThread(7, 'd1')).toEqual([
			{ id: '1', author: 'hansi[bot]', body: 'finding', isBot: true, path: 'a.ts', line: 4 },
			{ id: '2', author: 'ada', body: 'why?', isBot: false, path: 'a.ts', line: 4 }
		]);
	});

	test('the check run is a commit status that stays running when GitLab refuses to restart it', async () => {
		let posts = 0;
		const { github } = await connect({
			[`POST ${PROJECT}/statuses/abc`]: () => {
				posts++;
				return posts === 2
					? Response.json(
							{ message: 'Cannot transition status via :run from :running' },
							{ status: 400 }
						)
					: Response.json({});
			}
		});

		const id = await github.startCheckRun({
			headSha: 'abc',
			name: 'Hansi',
			externalId: 'repo1',
			detailsUrl: 'https://console/review'
		});
		await github.updateCheckRun(id, { title: 'Reviewing', summary: '' });
		await github.completeCheckRun(id, { conclusion: 'failure', title: 'Tier 4', summary: '' });

		expect(seen.map((s) => s.body)).toEqual([
			{ state: 'running', name: 'Hansi (repo1)', target_url: 'https://console/review' },
			{
				state: 'running',
				name: 'Hansi (repo1)',
				description: 'Reviewing',
				target_url: 'https://console/review'
			},
			{
				state: 'failed',
				name: 'Hansi (repo1)',
				description: 'Tier 4',
				target_url: 'https://console/review'
			}
		]);
	});

	test('failed checks leave out its own statuses and allowed failures', async () => {
		const { github } = await connect({
			[`GET ${PROJECT}/repository/commits/abc/statuses`]: () =>
				Response.json([
					{
						name: 'test',
						status: 'failed',
						description: 'exit 1',
						target_url: 'https://ci/1',
						author: ada
					},
					{ name: 'lint', status: 'failed', allow_failure: true, author: ada },
					{ name: 'Hansi', status: 'failed', author: bot },
					{ name: 'build', status: 'success', author: ada }
				])
		});

		expect(await github.getFailedChecks('abc', APP.id)).toEqual([
			{ name: 'test', conclusion: 'failure', output: 'exit 1\n\nhttps://ci/1', annotations: [] }
		]);
	});

	test('write access is Developer or above, and an unknown user has none', async () => {
		const { github } = await connect({
			'GET /api/v4/users': (request) =>
				Response.json(request.query.get('username') === 'ada' ? [{ id: 1 }] : []),
			[`GET ${PROJECT}/members/all/1`]: () => Response.json({ access_level: 30 })
		});

		expect(await github.hasWriteAccess('ada')).toBe(true);
		expect(await github.hasWriteAccess('mallory')).toBe(false);
	});

	test('reads files raw, with null for a missing one', async () => {
		const { github } = await connect({
			[`GET ${PROJECT}/repository/files/.hansi.yml/raw`]: (request) =>
				new Response(`language: de # ${request.query.get('ref')}`)
		});

		expect(await github.getFileContent('.hansi.yml', 'base')).toBe('language: de # base');
		expect(await github.getFileContent('missing.yml', 'base')).toBeNull();
	});

	test('reacts with eyes and links only issues of this project', async () => {
		const { github } = await connect({
			[`POST ${MR}/notes/5/award_emoji`]: () => Response.json({}),
			[`GET ${MR}/closes_issues`]: () =>
				Response.json([
					{ iid: 3, project_id: 42, title: 'Bug', description: 'Broken' },
					{ iid: 9, project_id: 7, title: 'Elsewhere', description: '' }
				]),
			[`GET ${MR}/diffs`]: () =>
				Response.json([
					{ old_path: 'a.ts', new_path: 'a.ts', diff: PATCH },
					{ old_path: 'b.png', new_path: 'b.png', diff: '' }
				])
		});

		await github.acknowledgeComment(7, { id: '5', kind: 'issue' });

		expect(seen[0]?.body).toEqual({ name: 'eyes' });
		expect(await github.getLinkedIssues(7)).toEqual([{ number: 3, title: 'Bug', body: 'Broken' }]);
		expect(await github.listPullRequestPatches(7)).toEqual([
			{ path: 'a.ts', patch: PATCH.trimEnd() },
			{ path: 'b.png' }
		]);
	});
});

test('contextLines maps unchanged lines to their old numbers', () => {
	expect([...contextLines(PATCH)]).toEqual([
		[10, 10],
		[13, 12]
	]);
});

describe('InstallationGitLabClientFactory', () => {
	test('speaks to the self-hosted instance the token names', async () => {
		const endpoint = serve({
			[`GET ${PROJECT}`]: () =>
				Response.json({ id: 42, web_url: 'https://git.example.com/acme/platform/rocket' })
		});
		const selfHosted: InstallationTokens = {
			async get() {
				return { ...(await source.get({ projectId: '', repositoryId: '' })), endpoint };
			}
		};

		const { filesUrl } = await new InstallationGitLabClientFactory(selfHosted, {
			apiUrl: 'http://127.0.0.1:9/api/v4'
		}).forRepository(repository);

		expect(filesUrl).toBe('https://git.example.com/acme/platform/rocket/-/blob');
	});
});
