import { describe, expect, test } from 'bun:test';
import type { LanguageModelUsage } from 'ai';
import { estimateCost, findPrice } from './pricing';

// hansi.codes' pricing tests (packages/llm/src/llm.test.ts), as they are.

describe('pricing', () => {
	const usage = (input: number, output: number, cacheRead = 0) =>
		({
			inputTokens: input,
			outputTokens: output,
			totalTokens: input + output,
			inputTokenDetails: {
				noCacheTokens: input - cacheRead,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: 0
			},
			outputTokenDetails: { textTokens: output, reasoningTokens: 0 }
		}) satisfies LanguageModelUsage;

	test('prices input, cached input and output tokens', () => {
		const price = { input: 3, output: 15, cache_read: 0.3 };
		expect(estimateCost(price, usage(1_000_000, 0))).toBeCloseTo(3);
		expect(estimateCost(price, usage(1_000_000, 1_000_000, 500_000))).toBeCloseTo(1.5 + 0.15 + 15);
	});

	test('returns null for unknown models', () => {
		expect(estimateCost(undefined, usage(10, 10))).toBeNull();
	});

	test('finds dated model snapshots', () => {
		const catalog = { openai: { 'gpt-x': { input: 1, output: 2 } } };
		expect(findPrice(catalog, 'openai', 'gpt-x-2026-01-01')).toEqual({ input: 1, output: 2 });
		expect(findPrice(catalog, 'openai-compatible', 'gpt-x')).toBeUndefined();
	});

	test('prices Bedrock OpenAI models that models.dev has not listed yet', () => {
		const sol = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 };
		const catalog = {
			openai: { 'gpt-6.1-sol': sol },
			'amazon-bedrock': { 'global.openai.gpt-6-sol': { input: 9, output: 9 } }
		};
		const regional = { input: 2.2, output: 11, cache_read: 0.11, cache_write: 2.75 };
		expect(findPrice(catalog, 'amazon-bedrock', 'global.openai.gpt-6.1-sol')).toEqual(sol);
		expect(findPrice(catalog, 'amazon-bedrock', 'us.openai.gpt-6.1-sol')).toEqual(regional);
		expect(findPrice(catalog, 'amazon-bedrock', 'openai.gpt-6.1-sol')).toEqual(regional);
		expect(findPrice(catalog, 'amazon-bedrock', 'global.openai.gpt-6-sol')).toEqual({
			input: 9,
			output: 9
		});
		expect(findPrice(catalog, 'amazon-bedrock', 'us-gov.openai.gpt-6.1-sol')).toBeUndefined();
		expect(findPrice(catalog, 'amazon-bedrock', 'global.anthropic.claude-x')).toBeUndefined();
	});
});
