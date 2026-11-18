import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '@hansi/engine';
import { MockLanguageModelV4 } from 'ai/test';
import type { EvalCase } from './case';
import { checkoutCase, reviewCase, type RunSettings } from './run';

// A local repository stands in for GitHub: the head adds a function with a zero check, and
// the case's patch takes the check out again: the bug the scripted review then reports.

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

const PATCH = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,4 @@
 export const one = 1;
 export function divide(a: number, b: number) {
-  return b === 0 ? 0 : a / b;
+  return a / b;
 }
`;

describe('checkoutCase and reviewCase', () => {
	let origin: string;
	let patchDir: string;
	let base: string;
	let head: string;
	const run = (args: string[]) =>
		git(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: origin });

	beforeAll(async () => {
		origin = await mkdtemp(join(tmpdir(), 'hansi-eval-origin-'));
		patchDir = await mkdtemp(join(tmpdir(), 'hansi-eval-patch-'));
		await git(['init', '--quiet', '-b', 'main', origin]);
		// A partial clone of a SHA, as reviews make, needs both of these from the server.
		await run(['config', 'uploadpack.allowFilter', 'true']);
		await run(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
		await Bun.write(join(origin, 'src/math.ts'), 'export const one = 1;\n');
		await Bun.write(
			join(origin, '.hansi.json'),
			JSON.stringify({ reviews: { profile: 'strict' } })
		);
		await run(['add', '.']);
		await run(['commit', '--quiet', '-m', 'base']);
		base = (await run(['rev-parse', 'HEAD'])).trim();
		await Bun.write(
			join(origin, 'src/math.ts'),
			'export const one = 1;\nexport function divide(a: number, b: number) {\n  return b === 0 ? 0 : a / b;\n}\n'
		);
		await run(['commit', '--quiet', '-am', 'head']);
		head = (await run(['rev-parse', 'HEAD'])).trim();
		await writeFile(join(patchDir, 'inject.patch'), PATCH);
	});
	afterAll(async () => {
		await rm(origin, { recursive: true, force: true });
		await rm(patchDir, { recursive: true, force: true });
	});

	const evalCase = (): EvalCase => ({
		id: 'divide',
		description: 'Division by zero planted by the patch',
		repo: `file://${origin}`,
		base,
		head,
		patch: join(patchDir, 'inject.patch'),
		pullRequest: { title: 'Simplify divide', body: '', author: 'octocat' },
		linkedIssues: [],
		expected: {
			verdict: 'request_changes',
			findings: [{ id: 'zero', path: 'src/math.ts', lines: [3, 3], issue: 'Divides by zero.' }]
		}
	});

	test('reviews the head with the patch applied and scores the findings', async () => {
		const checkout = await checkoutCase(evalCase());
		try {
			expect(checkout.diff).toContain('+  return a / b;');
			expect(checkout.diff).not.toContain('b === 0');
			expect(checkout.baseConfig).toContain('strict');
			expect(await Bun.file(join(checkout.dir, 'src/math.ts')).text()).toContain('return a / b;');

			const model = new MockLanguageModelV4({
				doGenerate: [
					toolCall('submit_review', {
						summary: 'Drops the zero check.',
						findings: [
							{
								path: 'src/math.ts',
								startLine: 3,
								endLine: 3,
								severity: 'major',
								category: 'bug',
								title: 'Division by zero',
								body: 'b can be 0.'
							}
						]
					}),
					toolCall('submit_verdicts', {
						verdicts: [{ id: 'F1', keep: true, reason: 'b can be 0' }]
					})
				]
			});
			const settings: RunSettings = {
				models: { review: { model, provider: 'mock', modelId: 'mock-1' } },
				subagents: false,
				log: { info: () => {}, warn: () => {} }
			};
			const result = await reviewCase(evalCase(), checkout, settings);

			expect(result.status).toBe('completed');
			if (result.status !== 'completed') return;
			expect(result.score).toMatchObject({
				caught: ['zero'],
				missed: [],
				extra: [],
				verdict: 'request_changes',
				verdictOk: true
			});
			expect(result.usage.map((u) => u.role)).toEqual(['review', 'verify']);
			// The review read the strict profile from the base commit.
			expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
				'demanding senior reviewer'
			);
		} finally {
			await checkout.close();
		}
	});

	test('reports a failed model call as a failed run instead of throwing', async () => {
		const checkout = await checkoutCase({ ...evalCase(), patch: undefined });
		try {
			const model = new MockLanguageModelV4({
				doGenerate: async () => {
					throw new Error('rate limited');
				}
			});
			const result = await reviewCase(evalCase(), checkout, {
				models: { review: { model, provider: 'mock', modelId: 'mock-1' } },
				subagents: false,
				log: { info: () => {}, warn: () => {} }
			});
			expect(result).toMatchObject({
				status: 'failed',
				error: expect.stringContaining('rate limited')
			});
		} finally {
			await checkout.close();
		}
	});
});
