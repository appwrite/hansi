import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { EngineContext } from './context';
import { git } from './git';
import { runChatJob } from './chat-job';
import type { ChatJob } from './jobs';
import { MemoryGitHub, MemoryResultsSink } from './testing';

// The chat job end to end against a local git remote, the in-memory GitHub and a scripted
// model: who gets an answer, and what the answer changes.

const usage = {
	inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 20, text: 20, reasoning: 0 }
};
const toolCalls = (...calls: [string, unknown][]) => ({
	content: calls.map(([toolName, input]) => ({
		type: 'tool-call' as const,
		toolCallId: toolName,
		toolName,
		input: JSON.stringify(input)
	})),
	finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
	usage,
	warnings: []
});
const text = (answer: string) => ({
	content: [{ type: 'text' as const, text: answer }],
	finishReason: { unified: 'stop' as const, raw: 'stop' },
	usage,
	warnings: []
});
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
	name: 'math'
};
const first = { attempts: 1, maxAttempts: 2 };

/** A completed review with one finding posted as review comment `rootId`. */
function seedFinding(github: MemoryGitHub, results: MemoryResultsSink) {
	results.queue({
		id: 'review0',
		status: 'completed',
		headSha,
		summary: 'Divides.',
		verdict: 'request_changes',
		tier: 'B',
		completedAt: '2026-10-01T00:00:00.000Z'
	});
	const rootId = 500;
	github.reviewComments.push({
		id: rootId,
		author: 'hansi[bot]',
		isBot: true,
		body: '**Division by zero**',
		path: 'src/math.ts',
		line: 2
	});
	results.findings.push({
		id: 'finding1',
		reviewId: 'review0',
		path: 'src/math.ts',
		startLine: 2,
		endLine: 2,
		severity: 'major',
		category: 'bug',
		title: 'Division by zero',
		body: '`b` can be 0.',
		suggestion: null,
		status: 'posted',
		dropReason: null,
		providerCommentId: rootId,
		createdAt: '2026-10-01T00:00:00.000Z'
	});
	return rootId;
}

describe('runChatJob', () => {
	test('a reply on a finding can remember a rule and dismiss the finding', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCalls(
					['remember', { rule: 'Callers never pass 0 to divide.' }],
					['mark_finding', { status: 'dismissed', reason: 'Callers check b first' }]
				),
				text('Makes sense, dismissing it.')
			]
		});
		const { github, results, context } = setup([model]);
		const rootId = seedFinding(github, results);
		github.reviewComments.push({
			id: 501,
			inReplyToId: rootId,
			author: 'octocat',
			isBot: false,
			body: 'Callers check b first.'
		});
		const job: ChatJob = {
			type: 'chat',
			repository,
			pullNumber: 7,
			comment: {
				id: 501,
				kind: 'review',
				rootCommentId: rootId,
				author: 'octocat',
				authorAssociation: 'MEMBER',
				url: 'https://github.test/pull/7#discussion_r501'
			},
			unmentioned: true
		};

		await runChatJob(job, context, first);

		expect(github.reactions).toEqual([{ id: 501, kind: 'review' }]);
		const reply = github.reviewComments.at(-1);
		expect(reply?.inReplyToId).toBe(rootId);
		expect(reply?.body).toBe('Makes sense, dismissing it.');
		expect(results.learnings).toEqual([
			{
				body: 'Callers never pass 0 to divide.',
				author: 'octocat',
				sourceUrl: 'https://github.test/pull/7#discussion_r501'
			}
		]);
		expect(results.findings[0]?.status).toBe('dismissed');
		expect(github.resolved.has(rootId)).toBe(true);
		// The summary is rebuilt without the finding, and the change request withdrawn.
		expect(github.summary()).toContain('Divides.');
		expect(results.review('review0')?.tier).toBe('S');
		expect(results.chatUsage[0]?.usage.map((u) => u.role)).toEqual(['chat']);
	});

	test('a reply between people in a thread Hansi did not start gets nothing', async () => {
		const { github, results, context } = setup();
		github.reviewComments.push(
			{ id: 600, author: 'alice', isBot: false, body: 'Rename this?', path: 'src/math.ts' },
			{ id: 601, inReplyToId: 600, author: 'bob', isBot: false, body: 'Sure.' }
		);

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: 601,
					kind: 'review',
					rootCommentId: 600,
					author: 'bob',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#discussion_r601'
				},
				unmentioned: true
			},
			context,
			first
		);

		expect(github.reactions).toEqual([]);
		expect(github.reviewComments).toHaveLength(2);
		expect(results.chatUsage).toEqual([]);
	});

	test('a conversation comment without a mention needs an open finding in a review body', async () => {
		const { github, context } = setup();

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: 700,
					kind: 'issue',
					author: 'bob',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#issuecomment-700'
				},
				unmentioned: true
			},
			context,
			first
		);

		expect(github.reactions).toEqual([]);
		expect(github.issueComments).toEqual([]);
	});

	test('the last attempt that fails says so in a fixed reply', async () => {
		const failing = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error('provider exploded with secret details');
			}
		});
		const { github, context } = setup([failing]);

		await expect(
			runChatJob(
				{
					type: 'chat',
					repository,
					pullNumber: 7,
					comment: {
						id: 800,
						kind: 'issue',
						author: 'bob',
						authorAssociation: 'MEMBER',
						url: 'https://github.test/pull/7#issuecomment-800'
					}
				},
				context,
				{ attempts: 2, maxAttempts: 2 }
			)
		).rejects.toThrow();

		expect(github.issueComments.map((c) => c.body)).toEqual([
			"Sorry, I couldn't answer that right now."
		]);
	});
});
