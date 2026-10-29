import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';
import { createModels, parseBedrockSecret } from './models';

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
