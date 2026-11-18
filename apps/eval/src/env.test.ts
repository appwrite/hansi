import { expect, test } from 'bun:test';
import { loadEvalEnv } from './env';

const fail = (message: string): never => {
	throw new Error(message);
};

test('reads the model variables', () => {
	const env = loadEvalEnv(
		{ HANSI_REVIEW_MODEL: 'anthropic:claude-sonnet-4-5', HANSI_AI_SECRET: 'key' },
		fail
	);
	expect(env).toMatchObject({
		HANSI_REVIEW_MODEL: 'anthropic:claude-sonnet-4-5',
		HANSI_SANDBOX_RUNTIME_CLASS: 'gvisor'
	});
});

test('rejects models on another provider than the review model, as the service does', () => {
	expect(() =>
		loadEvalEnv(
			{
				HANSI_REVIEW_MODEL: 'anthropic:claude-sonnet-4-5',
				HANSI_JUDGE_MODEL: 'openai:gpt-5',
				HANSI_AI_SECRET: 'key'
			},
			fail
		)
	).toThrow("HANSI_JUDGE_MODEL: use the review model's provider, anthropic");
});

test('names every missing variable at once', () => {
	expect(() => loadEvalEnv({ HANSI_REVIEW_MODEL: 'bedrock:x' }, fail)).toThrow(
		'HANSI_AI_SECRET is required for bedrock\nHANSI_AI_REGION is required for bedrock'
	);
});
