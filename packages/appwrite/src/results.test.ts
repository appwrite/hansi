import { afterEach, describe, expect, test } from 'bun:test';
import { AppwriteError } from './api';
import { AppwriteInstallationTokens } from './installation-tokens';
import { AppwriteResultsSink } from './results';

// A local server plays Appwrite's internal Reviews API.
type Handler = (request: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: Array<{
	method: string;
	path: string;
	secret: string | null;
	body: unknown;
	query?: string;
}> = [];

function serve(handler: Handler = () => new Response(null, { status: 204 })) {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.clone().text();
			requests.push({
				method: request.method,
				path: url.pathname,
				secret: request.headers.get('x-appwrite-reviews-secret'),
				body: text ? JSON.parse(text) : undefined,
				...(url.search ? { query: url.search } : {})
			});
			return handler(request);
		}
	});
	return { endpoint: `http://localhost:${server.port}/v1`, secret: 'reviews-secret' };
}

afterEach(async () => {
	await server?.stop(true);
	requests.length = 0;
});

const review = { projectId: 'project-1', reviewId: 'review-1' };
const invalidStatus = () =>
	Response.json(
		{ message: 'The review already ended.', code: 409, type: 'review_status_invalid' },
		{ status: 409 }
	);

describe('AppwriteResultsSink', () => {
	test('moves the review through its statuses with the project in every body', async () => {
		const sink = new AppwriteResultsSink(serve());

		expect(await sink.startReview(review, { headSha: 'h', baseSha: 'b' })).toBe(true);
		await sink.completeReview(review, {
			verdict: 'approve',
			tier: 'S',
			tierReason: 'Nothing open.',
			summary: 'Fine.',
			walkthrough: [],
			findings: [],
			providerReviewId: 9
		});
		await sink.skipReview(review, 'Closed.', 'h');
		await sink.failReview(review, 'Broke.');

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(
			Array(4).fill('PATCH /v1/reviews/review-1/status')
		);
		expect(requests.every((r) => r.secret === 'reviews-secret')).toBe(true);
		expect(requests.map((r) => r.body)).toEqual([
			{ projectId: 'project-1', status: 'processing', headSha: 'h', baseSha: 'b' },
			{
				projectId: 'project-1',
				status: 'completed',
				verdict: 'approve',
				tier: 'S',
				tierReason: 'Nothing open.',
				summary: 'Fine.',
				walkthrough: [],
				findings: [],
				providerReviewId: 9
			},
			{ projectId: 'project-1', status: 'skipped', reason: 'Closed.', headSha: 'h' },
			{ projectId: 'project-1', status: 'failed', reason: 'Broke.' }
		]);
	});

	test("reads and settles the pull request's history", async () => {
		const sink = new AppwriteResultsSink(
			serve((request) => {
				const path = new URL(request.url).pathname;
				if (path.endsWith('/reviews')) return Response.json({ reviews: [{ id: 'r1' }] });
				if (path.endsWith('/findings')) return Response.json({ findings: [{ id: 'f1' }] });
				if (path.endsWith('/learnings') && request.method === 'GET') {
					return Response.json({ learnings: ['Prefer early returns.'] });
				}
				return new Response(null, { status: request.method === 'POST' ? 201 : 204 });
			})
		);
		const pull = { projectId: 'project-1', repositoryId: 'repo-1', pullNumber: 7 };
		const repository = { projectId: 'project-1', repositoryId: 'repo-1' };

		expect(await sink.listReviews(pull)).toEqual([{ id: 'r1' }] as never);
		expect(await sink.listFindings(pull, { limit: 200 })).toEqual([{ id: 'f1' }] as never);
		await sink.updateFindings(pull, ['f1'], { status: 'dismissed', reason: 'Intended.' });
		await sink.updateFindings(pull, [], { status: 'dismissed', reason: 'Nothing.' });
		expect(await sink.listLearnings(repository)).toEqual(['Prefer early returns.']);
		await sink.createLearning(repository, { body: 'b', author: 'a', sourceUrl: 'https://x.test' });
		await sink.updateGrade(review, { tier: 'A', tierReason: 'One minor left.' });

		expect(requests).toEqual([
			{
				method: 'GET',
				path: '/v1/reviews/repositories/repo-1/pulls/7/reviews',
				secret: 'reviews-secret',
				body: undefined,
				query: '?projectId=project-1'
			},
			{
				method: 'GET',
				path: '/v1/reviews/repositories/repo-1/pulls/7/findings',
				secret: 'reviews-secret',
				body: undefined,
				query: '?projectId=project-1&limit=200'
			},
			{
				method: 'PATCH',
				path: '/v1/reviews/repositories/repo-1/pulls/7/findings/status',
				secret: 'reviews-secret',
				body: {
					projectId: 'project-1',
					findingIds: ['f1'],
					status: 'dismissed',
					reason: 'Intended.'
				}
			},
			{
				method: 'GET',
				path: '/v1/reviews/repositories/repo-1/learnings',
				secret: 'reviews-secret',
				body: undefined,
				query: '?projectId=project-1'
			},
			{
				method: 'POST',
				path: '/v1/reviews/repositories/repo-1/learnings',
				secret: 'reviews-secret',
				body: { projectId: 'project-1', body: 'b', author: 'a', sourceUrl: 'https://x.test' }
			},
			{
				method: 'PATCH',
				path: '/v1/reviews/review-1/tier',
				secret: 'reviews-secret',
				body: { projectId: 'project-1', tier: 'A', tierReason: 'One minor left.' }
			}
		]);
	});

	test('sends events in batches Appwrite takes, with ISO times', async () => {
		const sink = new AppwriteResultsSink(serve());
		const at = new Date('2026-10-27T12:00:00Z');
		const events = Array.from({ length: 250 }, (_, i) => ({ type: 'tool.grep', at, data: { i } }));

		await sink.recordEvents(review, events);
		await sink.recordUsage(review, []);

		const batches = requests.map((r) => (r.body as { events: unknown[] }).events);
		expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
		expect(requests[0]?.path).toBe('/v1/reviews/review-1/events');
		expect(batches[0]?.[0]).toEqual({
			type: 'tool.grep',
			at: '2026-10-27T12:00:00.000Z',
			data: { i: 0 }
		});
	});

	test('leaves only the unwritten batches after a failure', async () => {
		let calls = 0;
		const sink = new AppwriteResultsSink(
			serve(() =>
				++calls === 2
					? Response.json({ message: 'Down.', code: 503, type: 'general_unknown' }, { status: 503 })
					: new Response(null, { status: 204 })
			)
		);
		const at = new Date('2026-10-27T12:00:00Z');
		const events = Array.from({ length: 250 }, (_, i) => ({ type: 'tool.grep', at, data: { i } }));

		await expect(sink.recordEvents(review, events)).rejects.toThrow();
		expect(events).toHaveLength(150);
		await sink.recordEvents(review, events);

		expect(events).toHaveLength(0);
		const sent = requests.flatMap((r) => (r.body as { events: { data: { i: number } }[] }).events);
		// The failed batch is sent twice; the stored one is not.
		expect(sent.filter((event) => event.data.i === 0)).toHaveLength(1);
		expect(sent.filter((event) => event.data.i === 100)).toHaveLength(2);
	});

	test('waits out the abuse limit and sends the call again', async () => {
		let calls = 0;
		const sink = new AppwriteResultsSink(
			serve(() =>
				++calls === 1
					? Response.json(
							{ message: 'Too many.', code: 429, type: 'general_rate_limit_exceeded' },
							{
								status: 429,
								// Two seconds out: one to a second boundary, and a whole one.
								headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2) }
							}
						)
					: new Response(null, { status: 204 })
			)
		);

		const started = Date.now();
		await sink.failReview(review, 'Broke.');

		expect(requests).toHaveLength(2);
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});

	test('sends chat usage keyed on the repository and the comment', async () => {
		const sink = new AppwriteResultsSink(serve());
		const usage = [
			{ role: 'chat', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, durationMs: 3 }
		];

		await sink.recordChatUsage(
			{ projectId: 'project-1', repositoryId: 'repo-1', pullNumber: 7, commentId: 11 },
			usage
		);

		expect(usage).toHaveLength(0);
		expect(requests).toEqual([
			{
				method: 'POST',
				path: '/v1/reviews/repositories/repo-1/usage',
				secret: 'reviews-secret',
				body: {
					projectId: 'project-1',
					pullNumber: 7,
					commentId: 11,
					usage: [
						{
							role: 'chat',
							provider: 'p',
							model: 'm',
							inputTokens: 1,
							outputTokens: 2,
							durationMs: 3
						}
					]
				}
			}
		]);
	});

	test('treats a review that already ended as done', async () => {
		const sink = new AppwriteResultsSink(serve(invalidStatus));

		expect(await sink.startReview(review, { headSha: 'h', baseSha: 'b' })).toBe(false);
		await sink.failReview(review, 'Broke.');
	});

	test('throws other failures with their status and type', async () => {
		const sink = new AppwriteResultsSink(
			serve(() =>
				Response.json(
					{ message: 'nope', code: 403, type: 'general_access_forbidden' },
					{ status: 403 }
				)
			)
		);

		const error = await sink.skipReview(review, 'x').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AppwriteError);
		expect(error).toMatchObject({ status: 403, type: 'general_access_forbidden' });
	});
});

describe('AppwriteInstallationTokens', () => {
	test('mints a token scoped to the review repository', async () => {
		const tokens = new AppwriteInstallationTokens(
			serve(() =>
				Response.json(
					{
						token: 'ghs_x',
						expiresAt: '2026-10-27T13:00:00Z',
						appId: '123',
						appSlug: 'hansi'
					},
					{ status: 201 }
				)
			)
		);

		const token = await tokens.get({ projectId: 'project-1', repositoryId: 'repo-1' });

		expect(token).toEqual({
			token: 'ghs_x',
			expiresAt: new Date('2026-10-27T13:00:00Z'),
			app: { id: '123', slug: 'hansi' }
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				path: '/v1/reviews/repositories/repo-1/tokens',
				secret: 'reviews-secret',
				body: { projectId: 'project-1' }
			}
		]);
	});
});
