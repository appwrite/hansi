import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from './config';
import { parseGitDiff, type FileDiff } from './diff';
import { git } from './git';
import { fitDiff, runReview, type ReviewInput } from './review';
import { scriptedModel } from './testing';

let repo: string;
let baseSha: string;
let files: FileDiff[];

beforeAll(async () => {
	repo = await mkdtemp(join(tmpdir(), 'hansi-review-'));
	const run = (args: string[]) => git(args, { cwd: repo });
	await run(['init', '-q', '-b', 'main']);
	await run(['config', 'user.email', 'test@example.com']);
	await run(['config', 'user.name', 'Test']);
	const lines = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);
	await writeFile(join(repo, 'app.ts'), lines.join('\n') + '\n');
	await run(['add', '-A']);
	await run(['commit', '-q', '-m', 'base']);
	baseSha = (await run(['rev-parse', 'HEAD'])).trim();
	lines[9] = 'const v10 = 100;';
	await writeFile(join(repo, 'app.ts'), lines.join('\n') + '\n');
	await run(['commit', '-q', '-am', 'head']);
	files = parseGitDiff(await run(['diff', baseSha, 'HEAD']));
});

afterAll(() => rm(repo, { recursive: true, force: true }));

const input = (overrides: Partial<ReviewInput> = {}): ReviewInput => ({
	repoDir: repo,
	baseSha,
	pullRequest: { title: 'Change v10', body: '', author: 'octocat' },
	files,
	config: defaultConfig,
	openFindings: [],
	alreadyReported: [],
	trustedAuthor: true,
	...overrides
});

const finding = (title: string, overrides: Record<string, unknown> = {}) => ({
	path: 'app.ts',
	startLine: 10,
	endLine: 10,
	severity: 'major',
	category: 'bug',
	title,
	body: 'Details.',
	...overrides
});

describe('runReview', () => {
	test('places, filters, verifies and grades findings', async () => {
		const reviewer = scriptedModel([
			{ calls: [{ tool: 'read_file', input: { path: 'app.ts', startLine: 8, endLine: 12 } }] },
			{
				calls: [
					{
						tool: 'submit_review',
						input: {
							summary: 'Changes v10.',
							walkthrough: [{ path: 'app.ts', summary: 'v10 is 100 now.' }],
							findings: [
								finding('v10 overflows the counter', { suggestion: 'const v10 = 10;' }),
								finding('Off the diff', { startLine: 25, endLine: 25 }),
								finding('Just a note', { severity: 'info', category: 'documentation' }),
								finding('Old problem with v10 value', {
									severity: 'minor',
									startLine: 9,
									endLine: 11
								}),
								finding('Rejected by the verifier', { severity: 'minor' })
							],
							resolved: ['open-1', 'unknown'],
							tier: 'S'
						}
					}
				]
			}
		]);
		const verifier = scriptedModel([
			{
				calls: [
					{
						tool: 'submit_verdicts',
						input: {
							verdicts: [
								{ id: 'f1', keep: true, reason: 'Real.', suggestion_ok: false },
								{ id: 'f2', keep: false, reason: 'Handled in the caller.' }
							]
						}
					}
				]
			}
		]);
		const events: string[] = [];

		const result = await runReview(
			input({
				alreadyReported: [
					{ path: 'app.ts', startLine: 10, endLine: 10, title: 'Old problem with the v10 value' }
				],
				openFindings: [
					{
						id: 'open-1',
						path: 'app.ts',
						startLine: 3,
						endLine: 3,
						severity: 'minor',
						category: 'bug',
						title: 'Fixed',
						body: ''
					}
				]
			}),
			{ reviewer, verifier, emit: (type) => events.push(type) }
		);

		expect(result.findings).toEqual([
			{
				path: 'app.ts',
				startLine: 10,
				endLine: 10,
				severity: 'major',
				category: 'bug',
				title: 'v10 overflows the counter',
				body: 'Details.',
				suggestion: undefined
			}
		]);
		expect(result.dropped.map((f) => [f.title, f.reason])).toEqual([
			['Off the diff', 'Not on a changed line'],
			['Just a note', 'Below the minimum severity'],
			['Old problem with v10 value', 'Reported in an earlier review'],
			['Rejected by the verifier', 'Handled in the caller.']
		]);
		expect(result.resolved).toEqual(['open-1']);
		expect(result.tier).toBe('B');
		expect(result.tierReason).toBe('Limited by an open major finding: v10 overflows the counter');
		expect(result.verdict).toBe('request_changes');
		expect(result.partial).toBe(false);
		expect(events).toContain('tool.read_file');
		expect(events).toContain('verify.done');

		const verifyPrompt = JSON.stringify(verifier.doGenerateCalls[0]!.prompt);
		expect(verifyPrompt).toContain('<finding id=\\"f1\\"');
		expect(verifyPrompt).toContain('const v10 = 100;');
	});

	test('approves a clean pull request without calling the verifier', async () => {
		const reviewer = scriptedModel([
			{
				calls: [
					{ tool: 'submit_review', input: { summary: 'Small change.', findings: [], tier: 'S' } }
				]
			}
		]);
		const verifier = scriptedModel([]);
		const result = await runReview(input(), { reviewer, verifier });
		expect(result).toMatchObject({ findings: [], tier: 'S', verdict: 'approve' });
		expect(verifier.doGenerateCalls).toHaveLength(0);
	});

	test('keeps findings when the verifier never answers', async () => {
		const reviewer = scriptedModel([
			{
				calls: [
					{ tool: 'submit_review', input: { summary: 'x', findings: [finding('Bug')], tier: 'B' } }
				]
			}
		]);
		const verifier = scriptedModel([{ text: 'Hm.' }, { text: 'Hm.' }, { text: 'Hm.' }]);
		const result = await runReview(input(), { reviewer, verifier });
		expect(result.findings.map((f) => f.title)).toEqual(['Bug']);
	});

	test('findings over the comment limit still block', async () => {
		const reviewer = scriptedModel([
			{
				calls: [
					{ tool: 'submit_review', input: { summary: 'x', findings: [finding('Bug')], tier: 'S' } }
				]
			}
		]);
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
		const config = { ...defaultConfig, reviews: { ...defaultConfig.reviews, maxComments: 0 } };
		const result = await runReview(input({ config }), { reviewer, verifier });
		expect(result.findings).toEqual([]);
		expect(result.dropped.map((f) => f.reason)).toEqual(['Over the comment limit']);
		expect(result).toMatchObject({ tier: 'B', verdict: 'request_changes' });
	});

	test('does not approve when changed files were skipped unread', async () => {
		const lockfile: FileDiff = { ...files[0]!, path: 'bun.lock' };
		const reviewer = scriptedModel([
			{ calls: [{ tool: 'submit_review', input: { summary: 'x', findings: [], tier: 'S' } }] }
		]);
		const result = await runReview(input({ files: [...files, lockfile] }), { reviewer });
		expect(result).toMatchObject({ partial: true, verdict: 'comment' });
		expect(result.notShown).toEqual([{ path: 'bun.lock', reason: 'ignored' }]);
	});

	test('fails when the reviewer never submits', async () => {
		const reviewer = scriptedModel([{ text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }]);
		await expect(runReview(input(), { reviewer })).rejects.toThrow('did not submit');
	});
});

describe('fitDiff', () => {
	test('lists files past the budget instead of showing them', () => {
		const { shown, over } = fitDiff(files, 10);
		expect(shown).toEqual([]);
		expect(over.map((f) => f.path)).toEqual(['app.ts']);
		expect(fitDiff(files).shown).toHaveLength(1);
	});
});
