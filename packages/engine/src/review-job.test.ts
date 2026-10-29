import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { EngineContext } from './context';
import { SUMMARY_MARKER } from './format';
import { git } from './git';
import type { ReviewJob } from './jobs';
import { runReviewJob } from './review-job';
import { MemoryGitHub, MemoryResultsSink } from './testing';

// The review job end to end against a local git remote, the in-memory GitHub and a scripted
// model: what lands on GitHub and in Appwrite.

const usage = {
	inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 20, text: 20, reasoning: 0 }
};
const toolCall = (toolName: string, input: unknown) => ({
	content: [
		{ type: 'tool-call' as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }
	],
	finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
	usage,
	warnings: []
});
const finding = {
	path: 'src/math.ts',
	startLine: 2,
	endLine: 2,
	severity: 'major',
	category: 'bug',
	title: 'Division by zero',
	body: '`b` can be 0, and the result is Infinity.'
};

let remote: string;
let baseSha: string;
let headSha: string;

beforeAll(async () => {
	remote = await mkdtemp(join(tmpdir(), 'hansi-remote-'));
	const run = (...args: string[]) => git(args, { cwd: remote });
	await run('init', '--quiet', '--initial-branch=main');
	await run('config', 'user.email', 'test@example.com');
	await run('config', 'user.name', 'Test');
	await run('config', 'uploadpack.allowFilter', 'true');
	await run('config', 'uploadpack.allowAnySHA1InWant', 'true');
	await Bun.$`mkdir -p ${join(remote, 'src')}`;
	await writeFile(join(remote, 'src/math.ts'), 'export function divide(a, b) {\n  return 0;\n}\n');
	await run('add', '.');
	await run('commit', '--quiet', '-m', 'base');
	baseSha = (await run('rev-parse', 'HEAD')).trim();
	await writeFile(
		join(remote, 'src/math.ts'),
		'export function divide(a, b) {\n  return a / b;\n}\n'
	);
	await run('commit', '--quiet', '-am', 'divide');
	headSha = (await run('rev-parse', 'HEAD')).trim();
	await run('update-ref', 'refs/pull/7/head', headSha);
	await run('checkout', '--quiet', baseSha);
});
afterAll(() => rm(remote, { recursive: true, force: true }));

function setup(models: MockLanguageModelV4[] = []) {
	const github = new MemoryGitHub({
		number: 7,
		title: 'Divide for real',
		body: '',
		author: 'octocat',
		authorAssociation: 'MEMBER',
		draft: false,
		state: 'open',
		merged: false,
		baseRef: 'main',
		baseSha,
		headSha,
		cloneUrl: remote
	});
	const results = new MemoryResultsSink();
	const model = new MockLanguageModelV4({
		doGenerate: async () => {
			const next = models[0];
			throw new Error(`unexpected model call${next ? '' : ' (no script left)'}`);
		}
	});
	const context: EngineContext = {
		github,
		results,
		models: { review: { model: models[0] ?? model, provider: 'mock', modelId: 'mock-1' } },
		log: { info() {}, warn() {} }
	};
	return { github, results, context };
}

const repository = {
	projectId: 'project1',
	projectInternalId: '1',
	repositoryId: 'repo1',
	installationId: 'installation1',
	providerInstallationId: '2',
	providerRepositoryId: '3',
	owner: 'acme',
	name: 'math',
	consoleUrl: 'https://cloud.appwrite.io/console'
};
const job = (overrides: Partial<ReviewJob> = {}): ReviewJob => ({
	type: 'review',
	reviewId: 'review1',
	repository,
	pullNumber: 7,
	headSha: '',
	trigger: { kind: 'opened' },
	...overrides
});
const first = { attempts: 1, maxAttempts: 3 };

describe('runReviewJob', () => {
	test('posts the summary comment, a review linking to it, and a check run that follows the verdict', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCall('submit_review', {
					summary: 'Divides for real.',
					findings: [finding],
					tier: 'B',
					walkthrough: [{ path: 'src/math.ts', change: 'Returns a / b.' }]
				}),
				toolCall('submit_verdicts', {
					verdicts: [{ id: 'F1', keep: true, reason: 'b is not checked' }]
				})
			]
		});
		const { github, results, context } = setup([model]);
		github.patches = [
			{
				path: 'src/math.ts',
				patch:
					'@@ -1,3 +1,3 @@\n export function divide(a, b) {\n-  return 0;\n+  return a / b;\n }'
			}
		];
		results.queue({ id: 'review1' });

		await runReviewJob(job(), context, first);

		const summary = github.summary();
		expect(summary).toStartWith(SUMMARY_MARKER);
		expect(summary).toContain('Divides for real.');
		expect(summary).toContain('| Verdict |');
		expect(summary).toContain('<code>@hansi review</code>');
		expect(summary).not.toContain('appwrite-hansi:status');

		expect(github.reviews).toHaveLength(1);
		const [review] = github.reviews;
		expect(review?.event).toBe('REQUEST_CHANGES');
		expect(review?.commitId).toBe(headSha);
		expect(review?.body).toContain('#issuecomment-');
		expect(review?.comments.map((c) => [c.path, c.line])).toEqual([['src/math.ts', 2]]);

		const [check] = github.checkRuns;
		expect(check?.name).toBe('Hansi');
		expect(check?.outputs[0]?.title).toBe('Checking out the pull request');
		expect(check?.conclusion).toBe('failure');
		expect(check?.title).toStartWith('Tier B: ');
		expect(check?.detailsUrl).toBe(
			'https://cloud.appwrite.io/console/projects/project1/reviews/review1'
		);

		const stored = results.review('review1');
		expect(stored?.status).toBe('completed');
		expect(stored?.verdict).toBe('request_changes');
		expect(stored?.walkthrough).toEqual([{ path: 'src/math.ts', change: 'Returns a / b.' }]);
		const posted = results.findings.filter((f) => f.status === 'posted');
		expect(posted.map((f) => f.title)).toEqual(['Division by zero']);
		expect(posted[0]?.providerCommentId).toBe(github.reviewComments[0]!.id);
		expect(results.usage.map((u) => u.role)).toEqual(['review', 'verify']);
		expect(results.events.some((e) => e.type === 'review.posted')).toBe(true);
	});

	test("hansi.codes' comments on the same pull request are left alone", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCall('submit_review', { summary: 'Divides for real.', findings: [], tier: 'S' })
			]
		});
		const { github, results, context } = setup([model]);
		const theirs =
			'<!-- hans:summary -->\n\n<!-- hans:status -->\n> Reviewing\n<!-- /hans:status -->';
		github.issueComments.push({ id: 1, author: 'hansi-codes[bot]', isBot: true, body: theirs });
		results.queue({ id: 'review1' });

		await runReviewJob(job(), context, first);

		expect(github.issueComments[0]?.body).toBe(theirs);
		expect(github.issueComments).toHaveLength(2);
		expect(github.summary()).toContain('Divides for real.');
	});

	test('a mention of a closed pull request reacts and says why it is skipped', async () => {
		const { github, results, context } = setup();
		github.pullRequest = { ...github.pullRequest, state: 'closed', merged: true };
		results.queue({ id: 'review1', trigger: 'mention' });

		await runReviewJob(
			job({ trigger: { kind: 'mention', comment: { id: 55, kind: 'issue' } } }),
			context,
			first
		);

		expect(github.reactions).toEqual([{ id: 55, kind: 'issue' }]);
		expect(github.issueComments.map((c) => c.body)).toEqual([
			"This pull request is merged, so Hansi doesn't review it anymore."
		]);
		expect(results.review('review1')?.status).toBe('skipped');
		expect(github.checkRuns).toHaveLength(0);
	});

	test('a push of a commit that is already reviewed is skipped quietly', async () => {
		const { github, results, context } = setup();
		results.queue({ id: 'earlier', status: 'completed', headSha, completedAt: '2026-10-01' });
		results.queue({ id: 'review1', trigger: 'synchronize' });

		await runReviewJob(job({ trigger: { kind: 'synchronize' } }), context, first);

		expect(results.review('review1')?.status).toBe('skipped');
		expect(results.review('review1')?.headSha).toBe(headSha);
		expect(github.issueComments).toHaveLength(0);
	});

	test('a superseded review does nothing', async () => {
		const { github, results, context } = setup();
		results.queue({ id: 'review1', status: 'superseded' });

		await runReviewJob(job(), context, first);

		expect(github.checkRuns).toHaveLength(0);
		expect(results.skipped).toHaveLength(0);
	});

	test('a failure settles the check run without quoting the error', async () => {
		const failing = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error('provider exploded with secret details');
			}
		});
		const { github, results, context } = setup([failing]);
		results.queue({ id: 'review1' });

		await expect(runReviewJob(job(), context, { attempts: 3, maxAttempts: 3 })).rejects.toThrow();

		const [check] = github.checkRuns;
		expect(check?.status).toBe('completed');
		expect(check?.conclusion).toBe('neutral');
		expect(check?.title).toBe('Review failed');
		expect(check?.summary).toBe('The review did not finish.');
	});
});
