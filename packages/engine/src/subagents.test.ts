import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoConfig } from './config';
import { MockLanguageModelV4 } from 'ai/test';
import { runReview } from './review';
import { createSandboxTools, MAX_COMMANDS, type CommandRunner } from './sandbox';
import { semaphore } from './subagents';
import { oneFetchAtATime, type ReviewEvent } from './tools';

const diff = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function divide(a: number, b: number) {
-  return a / b;
+  const result = a / b;
+  return result;
 }
diff --git a/src/text.ts b/src/text.ts
index 1111111..2222222 100644
--- a/src/text.ts
+++ b/src/text.ts
@@ -1,3 +1,3 @@
 export function first(s: string) {
-  return s[0];
+  return s.charAt(1);
 }
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const old = 1;
`;

const usage = {
	inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 20, text: 20, reasoning: 0 }
};
const respond = (...calls: { toolName: string; input: unknown }[]) => ({
	content: calls.map((call, i) => ({
		type: 'tool-call' as const,
		toolCallId: `${call.toolName}-${i}`,
		toolName: call.toolName,
		input: JSON.stringify(call.input)
	})),
	finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
	usage,
	warnings: []
});
const finding = (path: string, line: number, title: string) => ({
	path,
	startLine: line,
	endLine: line,
	severity: 'major',
	category: 'bug',
	title,
	body: 'Explained.'
});

type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Role = 'lead' | 'subagent' | 'verify';
function roleOf(options: LanguageModelV4CallOptions): Role {
	const system = JSON.stringify(options.prompt[0]);
	if (system.includes('The lead reviewer gave you one task')) return 'subagent';
	if (system.includes('You are verifying findings')) return 'verify';
	return 'lead';
}
const hasToolResults = (options: LanguageModelV4CallOptions) =>
	options.prompt.some((message) => message.role === 'tool');
const promptText = (options: LanguageModelV4CallOptions) => JSON.stringify(options.prompt);

describe('subagents', () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'hans-subagents-'));
		await mkdir(join(repoDir, 'src'));
		await writeFile(
			join(repoDir, 'src/math.ts'),
			'export function divide(a: number, b: number) {\n  const result = a / b;\n  return result;\n}\n'
		);
		await writeFile(
			join(repoDir, 'src/text.ts'),
			'export function first(s: string) {\n  return s.charAt(1);\n}\n'
		);
	});
	afterAll(() => rm(repoDir, { recursive: true, force: true }));

	const review = (
		model: MockLanguageModelV4,
		extra: Partial<Parameters<typeof runReview>[0]> = {}
	) =>
		runReview({
			repoDir,
			diff,
			pullRequest: { title: 'Refactor', body: '', author: 'octocat' },
			config: parseRepoConfig('').config,
			models: { review: { model, provider: 'mock', modelId: 'mock-1' } },
			...extra
		});

	test('runs delegated tasks in parallel and verifies their findings with the reviewer’s', async () => {
		let running = 0;
		let mostAtOnce = 0;
		const subagentPrompts: string[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: async (options) => {
				const role = roleOf(options);
				if (role === 'subagent') {
					subagentPrompts.push(promptText(options));
					running++;
					mostAtOnce = Math.max(mostAtOnce, running);
					await Bun.sleep(20);
					running--;
					const text = promptText(options).includes('Check text.ts');
					return respond({
						toolName: 'report',
						input: text
							? {
									findings: [finding('src/text.ts', 2, 'Off by one')],
									notes: 'charAt(1) skips the first character.'
								}
							: { findings: [], notes: 'divide is unchanged in behavior.' }
					});
				}
				if (role === 'verify') {
					return respond({
						toolName: 'submit_verdicts',
						input: {
							verdicts: [
								{ id: 'F1', keep: true, reason: 'b can be 0' },
								{ id: 'F2', keep: true, reason: 'skips index 0' }
							]
						}
					});
				}
				if (!hasToolResults(options)) {
					return respond(
						{ toolName: 'delegate', input: { task: 'Check math.ts', paths: ['src/math.ts'] } },
						{
							toolName: 'delegate',
							input: { task: 'Check text.ts', paths: ['src/text.ts', 'src/old.ts'] }
						}
					);
				}
				expect(promptText(options)).toContain('already added to the review');
				return respond({
					toolName: 'submit_review',
					input: {
						summary: 'Refactors helpers.',
						findings: [finding('src/math.ts', 2, 'Division by zero')]
					}
				});
			}
		});
		const events: ReviewEvent[] = [];
		const result = await review(model, { onEvent: (event) => void events.push(event) });

		if (result.status !== 'completed') throw new Error('expected a completed review');
		expect(result.posted.map((f) => f.title).sort()).toEqual(['Division by zero', 'Off by one']);
		expect(mostAtOnce).toBe(2);
		// Each subagent sees its task and its own files' diff.
		const textPrompt = subagentPrompts.find((p) => p.includes('Check text.ts'))!;
		expect(textPrompt).toContain('s.charAt(1)');
		expect(textPrompt).not.toContain('const result = a / b');
		// A changed file that is not reviewed line by line is named as changed, with the reason.
		expect(textPrompt).toContain('src/old.ts (changed, but not reviewed line by line: deleted)');
		const started = events.filter((e) => e.type === 'subagent.started');
		expect(started.map((e) => e.data?.agent).sort()).toEqual(['sub-1', 'sub-2']);
		expect(events.find((e) => e.type === 'review.submitted')?.data).toMatchObject({
			findings: 2,
			fromSubagents: 1
		});
	});

	test('stops starting subagents at the limit and keeps the review going when one fails', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async (options) => {
				const role = roleOf(options);
				if (role === 'subagent') throw new Error('rate limited');
				if (!hasToolResults(options)) {
					return respond(
						{ toolName: 'delegate', input: { task: 'Check math.ts', paths: ['src/math.ts'] } },
						{ toolName: 'delegate', input: { task: 'Check text.ts', paths: ['src/text.ts'] } }
					);
				}
				const text = promptText(options);
				expect(text).toContain('The subagent failed');
				expect(text).toContain('limit of 1 subagents');
				return respond({
					toolName: 'submit_review',
					input: { summary: 'Refactors helpers.', findings: [] }
				});
			}
		});
		const result = await review(model, { limits: { maxSubagents: 1 } });
		expect(result.status).toBe('completed');
	});

	test('offers no delegate tool when subagents are off', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async () =>
				respond({
					toolName: 'submit_review',
					input: { summary: 'Refactors helpers.', findings: [] }
				})
		});
		await review(model, { limits: { maxSubagents: 0 } });
		const tools = model.doGenerateCalls[0]?.tools?.map((t) => t.name);
		expect(tools).toContain('read_file');
		expect(tools).not.toContain('delegate');
		expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain('subagents');
	});
});

test('agents sharing a budget share the command limit', async () => {
	const runner: CommandRunner = {
		run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false })
	};
	const budget = { used: 0 };
	const lead = createSandboxTools(runner, () => {}, budget);
	const sub = createSandboxTools(runner, () => {}, budget);
	const run = (tools: typeof lead) =>
		tools.run_command.execute!(
			{ command: 'true' } as never,
			{ toolCallId: 't', messages: [] } as never
		);
	for (let i = 0; i < MAX_COMMANDS; i++) await run(i % 2 ? lead : sub);
	expect(await run(sub)).toContain('budget');
	expect(await run(lead)).toContain('budget');
});

test('semaphore lets at most the limit run at once', async () => {
	const slots = semaphore(2);
	let running = 0;
	let mostAtOnce = 0;
	await Promise.all(
		Array.from({ length: 5 }, async () => {
			const release = await slots.acquire();
			running++;
			mostAtOnce = Math.max(mostAtOnce, running);
			await Bun.sleep(5);
			running--;
			release();
		})
	);
	expect(mostAtOnce).toBe(2);
});

test('fetches in one checkout take turns, even after a failure', async () => {
	const order: string[] = [];
	const step = (name: string, fail = false) =>
		oneFetchAtATime('/repo', async () => {
			order.push(`${name} start`);
			await Bun.sleep(5);
			order.push(`${name} end`);
			if (fail) throw new Error(name);
		});
	const other = oneFetchAtATime('/other', async () => void order.push('other'));
	await Promise.allSettled([step('a', true), step('b'), other]);
	expect(order.filter((entry) => entry !== 'other')).toEqual([
		'a start',
		'a end',
		'b start',
		'b end'
	]);
	expect(order.indexOf('other')).toBeLessThan(order.indexOf('a end'));
});
