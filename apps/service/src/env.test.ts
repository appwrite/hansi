import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';

const required = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_ORCHESTRATOR_ENDPOINT: 'http://orchestrator:8080',
	HANSI_SANDBOX_IMAGE: 'appwrite/hansi-toolchain:1',
	HANSI_REVIEW_MODEL: 'anthropic:claude-sonnet-4-5',
	HANSI_ANTHROPIC_API_KEY: 'sk-ant'
};

describe('parseEnv', () => {
	test('applies defaults', () => {
		const env = parseEnv(required);

		expect(env.HANSI_PORT).toBe(8080);
		expect(env.HANSI_CONCURRENCY).toBe(4);
		expect(env.HANSI_JOBS_PORT).toBe(8081);
		expect(env.HANSI_CONSUMER_COMMAND).toBeUndefined();
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

	test('needs the credentials of the providers the models use', () => {
		expect(() => parseEnv({ ...required, HANSI_ANTHROPIC_API_KEY: undefined })).toThrow(
			/HANSI_ANTHROPIC_API_KEY/
		);
		expect(() => parseEnv({ ...required, HANSI_VERIFY_MODEL: 'openai:gpt-5' })).toThrow(
			/Required by HANSI_VERIFY_MODEL \(openai\)[\s\S]*HANSI_OPENAI_API_KEY/
		);
		expect(() => parseEnv({ ...required, HANSI_VERIFY_MODEL: 'openai-compatible:llama' })).toThrow(
			/HANSI_OPENAI_COMPATIBLE_BASE_URL/
		);
	});

	test('takes Bedrock with a region and an API key or an access key pair', () => {
		const bedrock = { ...required, HANSI_REVIEW_MODEL: 'bedrock:us.anthropic.claude-x-v1:0' };
		expect(() => parseEnv(bedrock)).toThrow(/HANSI_BEDROCK_REGION[\s\S]*HANSI_BEDROCK_API_KEY/);
		const region = { ...bedrock, HANSI_BEDROCK_REGION: 'eu-central-1' };
		expect(parseEnv({ ...region, HANSI_BEDROCK_API_KEY: 'k' }).HANSI_BEDROCK_REGION).toBe(
			'eu-central-1'
		);
		expect(() => parseEnv({ ...region, HANSI_BEDROCK_ACCESS_KEY_ID: 'AKIA' })).toThrow(
			/HANSI_BEDROCK_SECRET_ACCESS_KEY/
		);
		expect(
			parseEnv({
				...region,
				HANSI_BEDROCK_ACCESS_KEY_ID: 'AKIA',
				HANSI_BEDROCK_SECRET_ACCESS_KEY: 's'
			}).HANSI_BEDROCK_ACCESS_KEY_ID
		).toBe('AKIA');
	});
});
