import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout } from './checkout';
import { defaultConfig, type RepoConfig } from './config';
import { git } from './git';
import type { PullRequest, PullRequestFile } from './github';
import type { ReviewJob } from './jobs';
import { runReviewJob, skipReason } from './review-job';
import { MemoryGitHub, MemoryResultsSink, MemorySandboxes, scriptedModel } from './testing';
import type { SandboxClient } from './sandbox';

let root: string;
let remote: string;
let baseSha: string;
let headSha: string;
let patch: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'hansi-job-'));
	remote = join(root, 'origin.git');
	const work = join(root, 'work');
	await mkdir(work);
	await git(['init', '--quiet', '--bare', remote], { cwd: root });
	// What GitHub allows: partial clones and fetching any commit by its id.
	await git(['config', 'uploadpack.allowFilter', 'true'], { cwd: remote });
	await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: remote });

	const run = (args: string[]) => git(args, { cwd: work });
	await run(['init', '--quiet', '-b', 'main']);
	await run(['config', 'user.email', 'test@example.com']);
	await run(['config', 'user.name', 'Test']);
	const lines = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
	await writeFile(join(work, 'app.ts'), lines.join('\n') + '\n');
	await writeFile(join(work, '.hansi.json'), '{ "reviews": { "minSeverity": "minor" } }');
	await run(['add', '-A']);
	await run(['commit', '--quiet', '-m', 'base']);
	baseSha = (await run(['rev-parse', 'HEAD'])).trim();

	lines[4] = 'const v5 = 500;';
	await writeFile(join(work, 'app.ts'), lines.join('\n') + '\n');
	await writeFile(join(work, 'größe.ts'), 'export const size = 1;\n');
	// The pull request tries to turn its own review off; settings are read from the base.
	await writeFile(join(work, '.hansi.json'), '{ "reviews": { "enabled": false } }');
	await run(['add', '-A']);
	await run(['commit', '--quiet', '-m', 'head']);
	headSha = (await run(['rev-parse', 'HEAD'])).trim();
	await run(['push', '--quiet', remote, 'main']);

	const diff = await run(['diff', baseSha, headSha, '--', 'app.ts']);
	patch = diff.slice(diff.indexOf('@@'));
});

afterAll(() => rm(root, { recursive: true, force: true }));

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
	number: 7,
	title: 'Bump v5',
	body: '',
	author: 'octocat',
	authorAssociation: 'MEMBER',
	draft: false,
	state: 'open',
	merged: false,
	base: { ref: 'main', sha: baseSha },
	head: { ref: 'bump', sha: headSha },
	url: 'https://github.com/acme/app/pull/7',
	...overrides
});

const job = (overrides: Partial<ReviewJob> = {}): ReviewJob => ({
	type: 'review',
	reviewId: 'review-1',
	repository: {
		projectId: 'project-1',
		projectInternalId: '1',
		repositoryId: 'repo-1',
		installationId: 'installation-1',
		providerInstallationId: '42',
		providerRepositoryId: '99',
		owner: 'acme',
		name: 'app'
	},
	pullNumber: 7,
	headSha,
	trigger: { kind: 'synchronize' },
	...overrides
});

const files = (): PullRequestFile[] => [
	{ path: 'app.ts', status: 'modified', additions: 1, deletions: 1, patch },
	{ path: '.hansi.json', status: 'modified', additions: 1, deletions: 1 }
];

const unusedSandboxes: SandboxClient = {
	create: () => Promise.reject(new Error('no sandboxes in this test'))
};

function setup(pr = pullRequest()) {
	const github = new MemoryGitHub(pr, files(), { url: `file://${remote}` });
	const results = new MemoryResultsSink();
	return { github, results, context: { github, results, sandboxes: unusedSandboxes } };
}

const review = (findings: unknown[], tier = 'B') =>
	scriptedModel([
		{
			calls: [
				{
					tool: 'submit_review',
					input: { summary: 'Changes v5.', findings, tier }
				}
			]
		}
	]);

const v5Finding = {
	path: 'app.ts',
	startLine: 5,
	endLine: 5,
	severity: 'major',
	category: 'bug',
	title: 'v5 overflows',
	body: 'It used to be 5.',
	suggestion: 'const v5 = 5;'
};

describe('runReviewJob', () => {
	test("runs the reviewer's commands in a sandbox of the head, and tears it down", async () => {
		const { github, results, context } = setup();
		const sandboxes = new MemorySandboxes((command) => ({
			exitCode: 1,
			stdout: `${command}: 1 failing`,
			stderr: '',
			timedOut: false,
			truncated: false
		}));
		const reviewer = scriptedModel([
			{ calls: [{ tool: 'run_command', input: { command: 'npm test' } }] },
			{
				calls: [
					{ tool: 'submit_review', input: { summary: 'Tests fail.', findings: [], tier: 'C' } }
				]
			}
		]);

		await runReviewJob(job(), { ...context, sandboxes }, { reviewer });

		expect(sandboxes.created).toEqual([{ archiveUrl: `memory://archive/${headSha}` }]);
		expect(sandboxes.commands).toEqual(['npm test']);
		expect(sandboxes.closed).toBe(1);
		const sent = JSON.stringify(reviewer.doGenerateCalls[1]?.prompt);
		expect(sent).toContain('npm test: 1 failing');
		const events = results.calls.find((call) => call.method === 'recordEvents');
		expect(JSON.stringify(events)).toContain('tool.run_command');
		expect(github.reviews).toHaveLength(1);
	});

	test('reviews by reading alone without sandboxes, as on a self-hosted Appwrite', async () => {
		const { github, context } = setup();
		const reviewer = scriptedModel([
			{
				calls: [{ tool: 'submit_review', input: { summary: 'Fine.', findings: [], tier: 'S' } }]
			}
		]);

		await runReviewJob(job(), { ...context, sandboxes: undefined }, { reviewer });

		const tools = (reviewer.doGenerateCalls[0]?.tools ?? []).map((tool) => tool.name);
		expect(tools).toContain('read_file');
		expect(tools).not.toContain('run_command');
		expect(JSON.stringify(reviewer.doGenerateCalls[0]?.prompt)).not.toContain('run_command');
		expect(github.reviews).toHaveLength(1);
	});

	test('reviews the pull request and posts the review', async () => {
		const { github, results, context } = setup();
		// The diff comes from the checkout: a stale file list from GitHub does not matter.
		github.files = [];
		const verifier = scriptedModel([
			{
				calls: [
					{
						tool: 'submit_verdicts',
						input: { verdicts: [{ id: 'f1', keep: true, reason: 'Real.', suggestion_ok: true }] }
					}
				]
			}
		]);

		await runReviewJob(job(), context, { reviewer: review([v5Finding]), verifier });

		expect(github.reviews).toHaveLength(1);
		const posted = github.reviews[0]!.review;
		expect(posted.commitId).toBe(headSha);
		expect(posted.event).toBe('REQUEST_CHANGES');
		expect(posted.body).toContain('Tier B');
		expect(posted.comments).toEqual([
			{
				path: 'app.ts',
				line: 5,
				startLine: undefined,
				side: 'RIGHT',
				body: expect.stringContaining('```suggestion\nconst v5 = 5;\n```')
			}
		]);
		expect(github.checkRuns).toEqual([
			{
				name: 'Hansi',
				headSha,
				status: 'completed',
				conclusion: 'failure',
				title: 'Tier B',
				summary: 'Changes v5.'
			}
		]);
		expect(results.calls.map((call) => call.method)).toEqual([
			'startReview',
			'recordEvents',
			'recordUsage',
			'completeReview'
		]);
		const completed = results.calls.at(-1)!;
		expect(completed).toMatchObject({
			method: 'completeReview',
			review: { projectId: 'project-1', reviewId: 'review-1' },
			outcome: { verdict: 'request_changes', tier: 'B', providerReviewId: 1 }
		});
	});

	test('approves a clean pull request, with settings from the base', async () => {
		const { github, results, context } = setup();
		await runReviewJob(job(), context, { reviewer: review([], 'S') });
		expect(github.reviews[0]!.review.event).toBe('APPROVE');
		expect(results.calls.at(-1)).toMatchObject({ outcome: { verdict: 'approve', tier: 'S' } });
	});

	test('still reviews when the installation cannot create check runs', async () => {
		const { github, results, context } = setup();
		github.checksForbidden = true;
		await runReviewJob(job(), context, { reviewer: review([], 'S') });
		expect(github.reviews).toHaveLength(1);
		const events = results.calls.find((call) => call.method === 'recordEvents');
		expect(JSON.stringify(events)).toContain('check.unavailable');
	});

	test('a retry after a posted review does not post it again', async () => {
		const { github, results, context } = setup();
		let failures = 1;
		const flaky = Object.assign(Object.create(results) as MemoryResultsSink, {
			async completeReview(...args: Parameters<MemoryResultsSink['completeReview']>) {
				if (failures-- > 0) throw new Error('Appwrite is down');
				return results.completeReview(...args);
			}
		});
		const flakyContext = { ...context, results: flaky };
		await expect(runReviewJob(job(), flakyContext, { reviewer: review([], 'S') })).rejects.toThrow(
			'Appwrite is down'
		);
		await runReviewJob(job(), flakyContext, { reviewer: review([], 'S') });
		expect(github.reviews).toHaveLength(1);
		expect(github.reviews[0]!.review.body).toContain('<!-- hansi:review review-1 -->');
		expect(results.calls.at(-1)).toMatchObject({
			method: 'completeReview',
			outcome: { providerReviewId: 1 }
		});
	});

	test('keeps the trace when writing it fails', async () => {
		const { results, context } = setup();
		let failures = 1;
		const flaky = Object.assign(Object.create(results) as MemoryResultsSink, {
			async recordEvents(...args: Parameters<MemoryResultsSink['recordEvents']>) {
				if (failures-- > 0) throw new Error('Appwrite is down');
				return results.recordEvents(...args);
			}
		});
		await expect(
			runReviewJob(job(), { ...context, results: flaky }, { reviewer: review([], 'S') })
		).rejects.toThrow('Appwrite is down');
		const recorded = results.calls.find((call) => call.method === 'recordEvents');
		expect(recorded).toMatchObject({
			events: expect.arrayContaining([expect.objectContaining({ type: 'review.done' })])
		});
	});

	test('comments on files with non-ASCII names', async () => {
		const { github, context } = setup();
		const finding = {
			...v5Finding,
			path: 'größe.ts',
			startLine: 1,
			endLine: 1,
			suggestion: undefined
		};
		const verifier = scriptedModel([
			{
				calls: [
					{
						tool: 'submit_verdicts',
						input: { verdicts: [{ id: 'f1', keep: true, reason: 'Real.' }] }
					}
				]
			}
		]);
		await runReviewJob(job(), context, { reviewer: review([finding]), verifier });
		expect(github.reviews[0]!.review.comments.map((c) => c.path)).toEqual(['größe.ts']);
	});

	test('skips a head another review job already reviewed, without checking it out', async () => {
		const { github, results, context } = setup();
		github.reviews.push({
			pullNumber: 7,
			review: {
				commitId: headSha,
				event: 'COMMENT',
				body: 'Looks fine.\n\n<!-- hansi:review review-0 -->',
				comments: []
			}
		});

		await runReviewJob(job(), context, { reviewer: scriptedModel([]) });

		expect(results.calls).toEqual([
			{
				method: 'skipReview',
				review: { projectId: 'project-1', reviewId: 'review-1' },
				reason: 'This commit was already reviewed.'
			}
		]);
		expect(github.reviews).toHaveLength(1);
	});

	test('does not skip for a marker a person wrote into their own review', async () => {
		const { github, context } = setup();
		github.reviews.push({
			pullNumber: 7,
			bot: false,
			review: {
				commitId: headSha,
				event: 'COMMENT',
				body: '<!-- hansi:review review-0 -->',
				comments: []
			}
		});

		await runReviewJob(job(), context, { reviewer: review([]) });

		expect(github.reviews).toHaveLength(2);
	});

	test('posts again on a retry when its earlier review was for an older head', async () => {
		const { github, results, context } = setup();
		github.reviews.push({
			pullNumber: 7,
			review: {
				commitId: 'f'.repeat(40),
				event: 'COMMENT',
				body: '<!-- hansi:review review-1 -->',
				comments: []
			}
		});

		await runReviewJob(job({ trigger: { kind: 'retry' } }), context, { reviewer: review([]) });

		expect(github.reviews.map((r) => r.review.commitId)).toEqual(['f'.repeat(40), headSha]);
		expect(results.calls.at(-1)).toMatchObject({ outcome: { providerReviewId: 2 } });
	});

	test('reviews the current head when the queued one is older', async () => {
		const { github, context } = setup();

		await runReviewJob(job({ headSha: 'f'.repeat(40) }), context, { reviewer: review([]) });

		expect(github.reviews[0]?.review.commitId).toBe(headSha);
	});

	test('stops on a redelivery of a review that already ended', async () => {
		const { github, results, context } = setup();
		results.ended = true;

		await runReviewJob(job(), context, { reviewer: scriptedModel([]) });

		expect(results.calls.map((call) => call.method)).toEqual(['startReview']);
		expect(github.reviews).toHaveLength(0);
	});

	test('marks the check and keeps the trace when the review fails', async () => {
		const { github, results, context } = setup();
		const broken = scriptedModel([{ calls: [{ tool: 'read_file', input: { path: 'app.ts' } }] }]);
		await expect(runReviewJob(job(), context, { reviewer: broken })).rejects.toThrow();
		expect(github.reviews).toHaveLength(0);
		expect(github.checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'neutral' });
		expect(results.calls.map((call) => call.method)).toEqual([
			'startReview',
			'recordEvents',
			'recordUsage'
		]);
	});
});

describe('skipReason', () => {
	const withReviews = (reviews: Partial<RepoConfig['reviews']>): RepoConfig => ({
		...defaultConfig,
		reviews: { ...defaultConfig.reviews, ...reviews }
	});

	test('skips closed pull requests, not ones with a newer head', () => {
		expect(skipReason(job(), pullRequest({ state: 'closed' }), null)).toBe(
			'The pull request is closed.'
		);
		expect(skipReason(job({ headSha: 'old' }), pullRequest(), null)).toBeNull();
	});

	test('follows the repository settings', () => {
		const pr = pullRequest();
		expect(skipReason(job(), pr, withReviews({ enabled: false }))).toContain('turned off');
		expect(skipReason(job(), pr, withReviews({ auto: false }))).toContain('Automatic');
		expect(skipReason(job(), pullRequest({ draft: true }), defaultConfig)).toContain('draft');
		expect(skipReason(job(), pr, withReviews({ baseBranches: ['release'] }))).toContain('main');
		expect(skipReason(job(), pr, withReviews({ baseBranches: ['main'] }))).toBeNull();
	});

	test('a mention reviews drafts and repositories without automatic reviews', () => {
		const mention = job({ trigger: { kind: 'mention', comment: { id: 1, kind: 'issue' } } });
		expect(
			skipReason(mention, pullRequest({ draft: true }), withReviews({ auto: false }))
		).toBeNull();
	});
});

describe('checkout', () => {
	test('checks out the head with the base commit available', async () => {
		const tree = await checkout({ url: `file://${remote}` }, { headSha, baseSha });
		try {
			expect((await git(['rev-parse', 'HEAD'], { cwd: tree.dir })).trim()).toBe(headSha);
			expect(await git(['show', `${baseSha}:app.ts`], { cwd: tree.dir })).toContain(
				'const v5 = 5;'
			);
		} finally {
			await tree.remove();
		}
	});
});
