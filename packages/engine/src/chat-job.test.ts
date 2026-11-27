import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { EngineContext } from './context';
import { git } from './git';
import { replyMarker, runChatJob, upTo } from './chat-job';
import { formatSummaryComment, SUMMARY_MARKER } from './format';
import type { ChatJob } from './jobs';
import { summaryMarkerFor } from './scope';
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
		botOnOwnBranch: false,
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
	provider: 'github' as const,
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
	const rootId = '500';
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

/**
 * A completed review that only commented, because its one finding, a minor bug, was open: what
 * the summary of appwrite-labs/infrastructure#1157 looked like before the reply that dismissed it.
 */
function seedWithheldApproval(
	github: MemoryGitHub,
	results: MemoryResultsSink,
	options: { approvesWhenSettled: boolean }
) {
	results.queue({
		id: 'review0',
		status: 'completed',
		headSha,
		summary: 'Divides.',
		verdict: 'comment',
		tier: 'A',
		tierReason: 'Limited by an open minor finding: Division by zero',
		completedAt: '2026-10-01T00:00:00.000Z'
	});
	const rootId = '500';
	github.reviewComments.push(
		{
			id: rootId,
			author: 'hansi[bot]',
			isBot: true,
			body: '**Division by zero**',
			path: 'src/math.ts',
			line: 2
		},
		{
			id: '501',
			inReplyToId: rootId,
			author: 'octocat',
			isBot: false,
			body: 'Intended: callers check b first.'
		}
	);
	const finding = {
		path: 'src/math.ts',
		startLine: 2,
		endLine: 2,
		severity: 'minor' as const,
		category: 'bug' as const,
		title: 'Division by zero',
		body: '`b` can be 0.'
	};
	results.findings.push({
		...finding,
		id: 'finding1',
		reviewId: 'review0',
		suggestion: null,
		status: 'posted',
		dropReason: null,
		providerCommentId: rootId,
		createdAt: '2026-10-01T00:00:00.000Z'
	});
	const summary = formatSummaryComment({
		repository: 'https://github.com/acme/math/blob',
		headSha,
		summary: 'Divides.',
		tier: 'A',
		tierReason: 'Limited by an open minor finding: Division by zero',
		verdict: 'comment',
		posted: [finding],
		resolved: [],
		stillOpen: [],
		dropped: [],
		walkthrough: [],
		approvalWithheld: 'Not approving while a bug finding is open: Division by zero',
		approvesWhenSettled: options.approvesWhenSettled,
		mention: '@hansi'
	});
	github.issueComments.push({
		id: '400',
		author: 'hansi[bot]',
		isBot: true,
		body: summary.replace(SUMMARY_MARKER, summaryMarkerFor(repository.repositoryId))
	});
	return rootId;
}

/** The author's reply on that finding, which the model accepts as intended. */
async function dismissByReply(context: EngineContext) {
	await runChatJob(
		{
			type: 'chat',
			repository,
			pullNumber: 7,
			comment: {
				id: '501',
				kind: 'review',
				rootCommentId: '500',
				author: 'octocat',
				authorAssociation: 'MEMBER',
				url: 'https://github.test/pull/7#discussion_r501'
			},
			unmentioned: true
		},
		context,
		first
	);
}

const dismissing = () =>
	new MockLanguageModelV4({
		doGenerate: [
			toolCalls(['mark_finding', { status: 'dismissed', reason: 'Intended policy' }]),
			text('Intended, dismissed.')
		]
	});

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
			id: '501',
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
				id: '501',
				kind: 'review',
				rootCommentId: rootId,
				author: 'octocat',
				authorAssociation: 'MEMBER',
				url: 'https://github.test/pull/7#discussion_r501'
			},
			unmentioned: true
		};

		await runChatJob(job, context, first);

		expect(github.reactions).toEqual([{ id: '501', kind: 'review' }]);
		// The 👀 turns into 👍 once the answer is posted.
		expect(github.finishedReactions).toEqual([{ id: '501', kind: 'review' }]);
		const reply = github.reviewComments.at(-1);
		expect(reply?.inReplyToId).toBe(rootId);
		expect(reply?.body).toBe(`Makes sense, dismissing it.\n\n${replyMarker('501')}`);
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

	test('dismissing the finding that held approval back approves the reviewed head', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: true });

		await dismissByReply(context);

		expect(results.findings[0]?.status).toBe('dismissed');
		const summary = github.summary() ?? '';
		expect(summary).toContain('✅ Approved');
		expect(summary).not.toContain('Not approving');
		expect(summary).not.toContain('Division by zero');
		expect(results.review('review0')?.tier).toBe('S');
		expect(github.reviews.map((r) => [r.event, r.commitId])).toEqual([['APPROVE', headSha]]);
		expect(github.reviews[0]?.body).toContain('Looks good to merge.');
		expect(github.checkRuns.map((r) => [r.name, r.headSha, r.conclusion, r.title])).toEqual([
			['Hansi', headSha, 'success', 'Tier S: Ready to merge']
		]);
	});

	test('a later settlement keeps the approval without approving again', async () => {
		const { github, results, context } = setup([dismissing(), dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: true });
		// A documentation note does not hold approval back, but its thread can still settle.
		github.reviewComments.push(
			{
				id: '510',
				author: 'hansi[bot]',
				isBot: true,
				body: '**Document divide**',
				path: 'src/math.ts',
				line: 1
			},
			{ id: '511', inReplyToId: '510', author: 'octocat', isBot: false, body: 'Not needed.' }
		);
		results.findings.push({
			...results.findings[0]!,
			id: 'finding2',
			severity: 'minor',
			category: 'documentation',
			title: 'Document divide',
			providerCommentId: '510'
		});

		await dismissByReply(context);
		context.models.review.model = dismissing();
		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '511',
					kind: 'review',
					rootCommentId: '510',
					author: 'octocat',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#discussion_r511'
				},
				unmentioned: true
			},
			context,
			first
		);

		expect(results.findings.map((f) => f.status)).toEqual(['dismissed', 'dismissed']);
		expect(github.summary()).toContain('✅ Approved');
		expect(github.reviews.map((r) => r.event)).toEqual(['APPROVE']);
		// The check run follows the grade: the open note held it at A, then nothing is open.
		expect(github.checkRuns.map((r) => [r.conclusion, r.title])).toEqual([
			['success', 'Tier A: Mergeable after minor fixes'],
			['success', 'Tier S: Ready to merge']
		]);
	});

	test('an approval GitHub refused is not claimed in the summary', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: true });
		github.createReview = async () => {
			throw new Error('GitHub is down');
		};

		await dismissByReply(context);

		expect(results.findings[0]?.status).toBe('dismissed');
		expect(github.summary()).toContain('💬 Commented');
		expect(github.checkRuns.map((r) => r.conclusion)).toEqual(['neutral']);
	});

	test('a findings list cut at its limit leaves the standing as it is', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: true });
		const settled = {
			...results.findings[0]!,
			status: 'resolved' as const,
			providerCommentId: null
		};
		for (let i = 0; i < 199; i++) results.findings.push({ ...settled, id: `old${i}` });
		const before = github.summary();

		await dismissByReply(context);

		expect(results.findings[0]?.status).toBe('dismissed');
		expect(github.summary()).toBe(before);
		expect(results.review('review0')?.tier).toBe('A');
		expect(github.reviews).toEqual([]);
		expect(github.checkRuns).toEqual([]);
	});

	test('an approved summary without the settlement mark is not taken as an approval', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: false });
		// A review's final summary is written before its GitHub review is posted.
		const summary = github.issueComments[0]!;
		summary.body = summary.body.replace('💬 Commented', '✅ Approved');

		await dismissByReply(context);

		expect(github.summary()).toContain('💬 Commented');
		expect(github.reviews).toEqual([]);
	});

	test('a review that could not have approved anyway only refreshes its summary', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: false });

		await dismissByReply(context);

		const summary = github.summary() ?? '';
		expect(summary).toContain('💬 Commented');
		expect(summary).not.toContain('Division by zero');
		expect(github.reviews).toEqual([]);
		// The grade still moves, so the check run stops showing the dismissed finding's tier.
		expect(github.checkRuns.map((r) => [r.conclusion, r.title])).toEqual([
			['neutral', 'Tier S: Ready to merge']
		]);
	});

	test('a push since the review keeps the approval for the review of the new commits', async () => {
		const { github, results, context } = setup([dismissing()]);
		seedWithheldApproval(github, results, { approvesWhenSettled: true });
		// The chat job reads the head first; the settlement then sees a newer one.
		github.nextHeads.push(headSha, 'f'.repeat(40));

		await dismissByReply(context);

		expect(github.summary()).toContain('💬 Commented');
		expect(github.reviews).toEqual([]);
		expect(github.checkRuns).toEqual([]);
	});

	test('a mention in the conversation can settle an inline finding and close its thread', async () => {
		// appwrite-labs/application-configuration#1420: the author answered in the conversation,
		// not in the finding's thread.
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCalls(['mark_finding', { status: 'dismissed', reason: 'Callers check b first' }]),
				text('Agreed, dismissing it.')
			]
		});
		const { github, results, context } = setup([model]);
		const rootId = seedFinding(github, results);
		github.issueComments.push({
			id: '910',
			author: 'octocat',
			isBot: false,
			body: "@hansi read the comments - it's resolved"
		});

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '910',
					kind: 'issue',
					author: 'octocat',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#issuecomment-910'
				}
			},
			context,
			first
		);

		expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Division by zero');
		expect(github.issueComments.map((c) => c.body)).toContain(
			`Agreed, dismissing it.\n\n${replyMarker('910')}`
		);
		expect(results.findings[0]?.status).toBe('dismissed');
		expect(github.resolved.has(rootId)).toBe(true);
		expect(results.review('review0')?.tier).toBe('S');
	});

	test('a conversation comment without a mention leaves inline findings to their threads', async () => {
		const { github, results, context } = setup();
		seedFinding(github, results);
		github.issueComments.push({
			id: '920',
			author: 'octocat',
			isBot: false,
			body: 'Division by zero is fine here.'
		});

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '920',
					kind: 'issue',
					author: 'octocat',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#issuecomment-920'
				},
				unmentioned: true
			},
			context,
			first
		);

		expect(github.reactions).toEqual([]);
		expect(results.findings[0]?.status).toBe('posted');
	});

	test("a thread on another project's finding is left to that project", async () => {
		const { github, results, context } = setup();
		const rootId = seedFinding(github, results);
		// The finding belongs to another repository row, so it is not in this project's database.
		results.findings.length = 0;
		github.reviewComments.push({
			id: '501',
			inReplyToId: rootId,
			author: 'octocat',
			isBot: false,
			body: '@hansi is this really a bug?'
		});
		const job: ChatJob = {
			type: 'chat',
			repository,
			pullNumber: 7,
			comment: {
				id: '501',
				kind: 'review',
				rootCommentId: rootId,
				author: 'octocat',
				authorAssociation: 'MEMBER',
				url: 'https://github.test/pull/7#discussion_r501'
			}
		};

		await runChatJob(job, context, first);

		expect(github.reactions).toEqual([]);
		expect(github.reviewComments.at(-1)?.id).toBe('501');
	});

	test('a reply between people in a thread Hansi did not start gets nothing', async () => {
		const { github, results, context } = setup();
		github.reviewComments.push(
			{ id: '600', author: 'alice', isBot: false, body: 'Rename this?', path: 'src/math.ts' },
			{ id: '601', inReplyToId: '600', author: 'bob', isBot: false, body: 'Sure.' }
		);

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '601',
					kind: 'review',
					rootCommentId: '600',
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
					id: '700',
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

	test('the answer is to the queued comment, not to a reply posted after it', async () => {
		const model = new MockLanguageModelV4({ doGenerate: [text('It returns a / b.')] });
		const { github, context } = setup([model]);
		github.issueComments.push(
			{ id: '900', author: 'bob', isBot: false, body: '@hansi what does divide return?' },
			{ id: '901', author: 'carol', isBot: false, body: 'Unrelated: ship it on Friday?' }
		);
		const job: ChatJob = {
			type: 'chat',
			repository,
			pullNumber: 7,
			comment: {
				id: '900',
				kind: 'issue',
				author: 'bob',
				authorAssociation: 'MEMBER',
				url: 'https://github.test/pull/7#issuecomment-900'
			}
		};

		await runChatJob(job, context, first);

		const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
		expect(prompt).toContain('what does divide return?');
		expect(prompt).not.toContain('ship it on Friday');
		expect(github.issueComments.at(-1)?.body).toBe(`It returns a / b.\n\n${replyMarker('900')}`);
	});

	test('a retry after the answer was posted does not answer again', async () => {
		const { github, results, context } = setup();
		github.issueComments.push(
			{ id: '950', author: 'bob', isBot: false, body: '@hansi what does divide return?' },
			{
				id: '951',
				author: 'hansi[bot]',
				isBot: true,
				body: `It returns a / b.\n\n${replyMarker('950')}`
			}
		);

		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '950',
					kind: 'issue',
					author: 'bob',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#issuecomment-950'
				}
			},
			context,
			{ attempts: 2, maxAttempts: 2 }
		);

		expect(github.issueComments).toHaveLength(2);
		expect(results.chatUsage).toEqual([]);

		// It still finds the answer once more than 20 newer comments follow it.
		for (let id = 952; id < 980; id++) {
			github.issueComments.push({
				id: String(id),
				author: 'carol',
				isBot: false,
				body: 'More talk.'
			});
		}
		await runChatJob(
			{
				type: 'chat',
				repository,
				pullNumber: 7,
				comment: {
					id: '950',
					kind: 'issue',
					author: 'bob',
					authorAssociation: 'MEMBER',
					url: 'https://github.test/pull/7#issuecomment-950'
				}
			},
			context,
			{ attempts: 2, maxAttempts: 2 }
		);
		expect(github.issueComments).toHaveLength(30);
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
						id: '800',
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
		expect(github.finishedReactions).toEqual([{ id: '800', kind: 'issue' }]);
	});

	test('a failed attempt that will be retried keeps the 👀', async () => {
		const failing = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error('provider exploded');
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
						id: '810',
						kind: 'issue',
						author: 'bob',
						authorAssociation: 'MEMBER',
						url: 'https://github.test/pull/7#issuecomment-810'
					}
				},
				context,
				first
			)
		).rejects.toThrow();

		expect(github.reactions).toEqual([{ id: '810', kind: 'issue' }]);
		expect(github.finishedReactions).toEqual([]);
	});
});

test('a thread is cut at the answered comment by position, not by comparing ids', () => {
	// Opaque ids sort apart from their order, and GitHub's do as strings ('999' > '1000').
	const thread = [{ id: '999' }, { id: '1000' }, { id: 'cmt_b' }, { id: 'cmt_a' }];

	expect(upTo(thread, '1000')).toEqual([{ id: '999' }, { id: '1000' }]);
	expect(upTo(thread, 'cmt_b')).toEqual(thread.slice(0, 3));
	expect(upTo(thread, 'gone')).toEqual(thread);
});
