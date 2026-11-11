import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';
import { createModels, createStrengths, parseBedrockSecret } from './models';

const base = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_AI_SECRET: 'bedrock-key',
	HANSI_AI_REGION: 'eu-central-1'
};

describe('createModels', () => {
	test('resolves the models through their provider, keeping colons in the model id', () => {
		const models = createModels(
			parseEnv({
				...base,
				HANSI_REVIEW_MODEL: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
				HANSI_VERIFY_MODEL: 'bedrock:amazon.nova-pro-v1:0'
			})
		);

		// Named as hansi.codes names it, which the engine's prompt caching goes by.
		expect(models.review.provider).toBe('amazon-bedrock');
		expect(models.review.modelId).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
		expect(models.review.reasoningEffort).toBeNull();
		expect(models.verify?.modelId).toBe('amazon.nova-pro-v1:0');
	});

	test('reaches OpenAI-compatible servers at their base URL', () => {
		const models = createModels(
			parseEnv({
				...base,
				HANSI_AI_SECRET: undefined,
				HANSI_AI_BASE_URL: 'http://ollama:11434/v1',
				HANSI_REVIEW_MODEL: 'openai-compatible:qwen3:32b'
			})
		);
		expect(models.review.provider).toBe('openai-compatible');
		expect(models.review.modelId).toBe('qwen3:32b');
		expect(models.verify).toBeUndefined();
	});
});

describe('parseBedrockSecret', () => {
	test('takes a Bedrock API key', () => {
		expect(parseBedrockSecret(' bedrock-api-key-123 ')).toEqual({ apiKey: 'bedrock-api-key-123' });
	});

	test('takes an IAM key pair, with an optional session token', () => {
		expect(parseBedrockSecret('AKIAABCDEFGHIJKLMNOP:secret/Key+1')).toEqual({
			accessKeyId: 'AKIAABCDEFGHIJKLMNOP',
			secretAccessKey: 'secret/Key+1'
		});
		expect(parseBedrockSecret('ASIAABCDEFGHIJKLMNOP:secret:session:token')).toEqual({
			accessKeyId: 'ASIAABCDEFGHIJKLMNOP',
			secretAccessKey: 'secret',
			sessionToken: 'session:token'
		});
	});
});

describe('reasoning', () => {
	test('names the effort on each model, for the engine to send with every call', () => {
		const models = createModels(
			parseEnv({
				...base,
				HANSI_REVIEW_MODEL: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
				HANSI_REVIEW_REASONING: 'high',
				HANSI_VERIFY_REASONING: 'low'
			})
		);

		expect(models.review.reasoningEffort).toBe('high');
		expect(models.verify?.reasoningEffort).toBe('low');
		expect(models.verify?.modelId).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
	});
});

describe('createStrengths', () => {
	const normal = {
		...base,
		HANSI_REVIEW_MODEL: 'bedrock:global.openai.gpt-6-luna',
		HANSI_VERIFY_MODEL: 'bedrock:global.anthropic.claude-sonnet-5-5',
		HANSI_REVIEW_REASONING: 'high'
	};

	test('gives each strength its own models, with subagents on expert and no sandbox on basic', () => {
		const strengths = createStrengths(
			parseEnv({
				...normal,
				HANSI_BASIC_REVIEW_MODEL: 'bedrock:global.openai.gpt-6-luna',
				HANSI_EXPERT_REVIEW_MODEL: 'bedrock:global.anthropic.claude-opus-5-5'
			})
		);

		expect(strengths.basic.models.review.modelId).toBe('global.openai.gpt-6-luna');
		// Without a verify model of its own, basic verifies with its review model.
		expect(strengths.basic.models.verify).toBeUndefined();
		expect(strengths.basic.subagents).toBe(false);
		expect(strengths.basic.sandboxes).toBe(false);
		expect(strengths.normal.sandboxes).toBe(true);
		expect(strengths.expert.sandboxes).toBe(true);
		expect(strengths.normal.models.verify?.modelId).toBe('global.anthropic.claude-sonnet-5-5');
		expect(strengths.normal.subagents).toBe(false);
		expect(strengths.expert.models.review.modelId).toBe('global.anthropic.claude-opus-5-5');
		expect(strengths.expert.models.review.reasoningEffort).toBe('high');
		expect(strengths.expert.subagents).toBe(true);
	});

	test('reviews with the normal models at a strength that has none of its own', () => {
		const strengths = createStrengths(parseEnv(normal));

		expect(strengths.basic.models).toBe(strengths.normal.models);
		expect(strengths.expert.models).toBe(strengths.normal.models);
		expect(strengths.expert.subagents).toBe(true);
	});
});
