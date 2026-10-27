import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { parseEnv } from './env';
import { createModels, parseBedrockSecret } from './models';

const base = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_AI_SECRET: 'bedrock-key',
	HANSI_AI_REGION: 'eu-central-1'
};

function model(value: unknown): { provider: string; modelId: string } {
	return value as { provider: string; modelId: string };
}

describe('createModels', () => {
	test('resolves the models through their provider, keeping colons in the model id', () => {
		const models = createModels(
			parseEnv({
				...base,
				HANSI_REVIEW_MODEL: 'bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0',
				HANSI_VERIFY_MODEL: 'bedrock:amazon.nova-pro-v1:0'
			})
		);

		expect(model(models.reviewer).provider).toContain('bedrock');
		expect(model(models.reviewer).modelId).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
		expect(model(models.verifier).modelId).toBe('amazon.nova-pro-v1:0');
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
		expect(model(models.reviewer).provider).toStartWith('openai-compatible');
		expect(model(models.reviewer).modelId).toBe('qwen3:32b');
		expect(models.verifier).toBeUndefined();
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
	test('sends the effort with each call', async () => {
		const bodies: Record<string, unknown>[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				bodies.push((await request.json()) as Record<string, unknown>);
				return Response.json({
					id: 'r',
					created: 0,
					model: 'm',
					choices: [
						{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
				});
			}
		});
		try {
			const models = createModels(
				parseEnv({
					...base,
					HANSI_AI_BASE_URL: `http://localhost:${server.port}/v1`,
					HANSI_REVIEW_MODEL: 'openai-compatible:qwen3:32b',
					HANSI_REVIEW_REASONING: 'high',
					HANSI_VERIFY_REASONING: 'low'
				})
			);
			await generateText({ model: models.reviewer, prompt: 'hi' });
			await generateText({ model: models.verifier!, prompt: 'hi' });
		} finally {
			await server.stop();
		}
		expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'low']);
		expect(bodies[1]?.model).toBe('qwen3:32b');
	});
});
