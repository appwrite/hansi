import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';
import { createModels } from './models';

const base = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_BEDROCK_REGION: 'eu-central-1',
	HANSI_BEDROCK_API_KEY: 'bedrock-key',
	HANSI_OPENAI_COMPATIBLE_BASE_URL: 'http://ollama:11434/v1'
};

function model(value: unknown): { provider: string; modelId: string } {
	return value as { provider: string; modelId: string };
}

describe('createModels', () => {
	test('resolves each model through its provider, keeping colons in the model id', () => {
		const models = createModels(
			parseEnv({
				...base,
				HANSI_REVIEW_MODEL: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
				HANSI_VERIFY_MODEL: 'openai-compatible:qwen3:32b'
			})
		);

		expect(model(models.reviewer).provider).toContain('bedrock');
		expect(model(models.reviewer).modelId).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
		expect(model(models.verifier).provider).toStartWith('openai-compatible');
		expect(model(models.verifier).modelId).toBe('qwen3:32b');
	});

	test('leaves the verifier to the reviewer when unset', () => {
		const models = createModels(
			parseEnv({ ...base, HANSI_REVIEW_MODEL: 'bedrock:amazon.nova-pro-v1:0' })
		);
		expect(models.verifier).toBeUndefined();
	});
});
