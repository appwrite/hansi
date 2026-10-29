import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';

const required = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_ORCHESTRATOR_ENDPOINT: 'http://orchestrator:8080',
	HANSI_SANDBOX_IMAGE: 'appwrite/hansi-toolchain:1',
	HANSI_REVIEW_MODEL: 'anthropic:claude-sonnet-4-5',
	HANSI_AI_SECRET: 'sk-ant'
};

describe('parseEnv', () => {
	test('applies defaults', () => {
		const env = parseEnv(required);

		expect(env.HANSI_PORT).toBe(8080);
		expect(env.HANSI_CONCURRENCY).toBe(4);
		expect(env.HANSI_JOBS_PORT).toBe(8081);
		expect(env.HANSI_CONSUMER_COMMAND).toBeUndefined();
		expect(env.HANSI_SANDBOX_RUNTIME_CLASS).toBe('gvisor');
	});

	test('takes a known sandbox isolation tier only', () => {
		expect(
			parseEnv({ ...required, HANSI_SANDBOX_RUNTIME_CLASS: 'runc' }).HANSI_SANDBOX_RUNTIME_CLASS
		).toBe('runc');
		expect(() => parseEnv({ ...required, HANSI_SANDBOX_RUNTIME_CLASS: 'docker' })).toThrow(
			/HANSI_SANDBOX_RUNTIME_CLASS/
		);
	});

	test('runs without sandboxes, but not sandboxes without an image', () => {
		const readOnly: Record<string, string | undefined> = {
			...required,
			HANSI_ORCHESTRATOR_ENDPOINT: undefined,
			HANSI_SANDBOX_IMAGE: undefined
		};
		expect(parseEnv(readOnly).HANSI_ORCHESTRATOR_ENDPOINT).toBeUndefined();
		expect(() => parseEnv({ ...readOnly, HANSI_ORCHESTRATOR_ENDPOINT: 'http://o:8080' })).toThrow(
			/HANSI_SANDBOX_IMAGE/
		);
	});

	test('names every missing variable', () => {
		expect(() => parseEnv({})).toThrow(/HANSI_APPWRITE_ENDPOINT[\s\S]*HANSI_REVIEW_MODEL/);
	});

	test('takes provider:model ids from known providers only', () => {
		expect(parseEnv({ ...required, HANSI_REVIEW_MODEL: 'anthropic:x' }).HANSI_REVIEW_MODEL).toBe(
			'anthropic:x'
		);
		for (const id of ['anthropic/claude-sonnet-4.5', 'nope:model', 'anthropic:']) {
			expect(() => parseEnv({ ...required, HANSI_REVIEW_MODEL: id })).toThrow(
				/provider:model[\s\S]*HANSI_REVIEW_MODEL/
			);
		}
	});

	test('needs the credentials of the provider, and one provider for both models', () => {
		expect(() => parseEnv({ ...required, HANSI_AI_SECRET: undefined })).toThrow(
			/Required by anthropic[\s\S]*HANSI_AI_SECRET/
		);
		expect(() => parseEnv({ ...required, HANSI_VERIFY_MODEL: 'openai:gpt-5' })).toThrow(
			/HANSI_VERIFY_MODEL/
		);
		const local = {
			...required,
			HANSI_AI_SECRET: undefined,
			HANSI_REVIEW_MODEL: 'openai-compatible:qwen3:32b'
		};
		expect(() => parseEnv(local)).toThrow(/HANSI_AI_BASE_URL/);
		expect(
			parseEnv({ ...local, HANSI_AI_BASE_URL: 'http://ollama:11434/v1' }).HANSI_AI_SECRET
		).toBeUndefined();
	});

	test('takes Bedrock with a region', () => {
		const bedrock = { ...required, HANSI_REVIEW_MODEL: 'bedrock:us.anthropic.claude-x-v1:0' };
		expect(() => parseEnv(bedrock)).toThrow(/HANSI_AI_REGION/);
		expect(parseEnv({ ...bedrock, HANSI_AI_REGION: 'eu-central-1' }).HANSI_AI_REGION).toBe(
			'eu-central-1'
		);
	});

	test('takes the AI SDK reasoning levels', () => {
		expect(parseEnv({ ...required, HANSI_REVIEW_REASONING: 'xhigh' }).HANSI_REVIEW_REASONING).toBe(
			'xhigh'
		);
		expect(() => parseEnv({ ...required, HANSI_VERIFY_REASONING: 'extreme' })).toThrow(
			/HANSI_VERIFY_REASONING/
		);
	});
});
