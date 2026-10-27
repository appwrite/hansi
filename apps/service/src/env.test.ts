import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';

const required = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_ORCHESTRATOR_ENDPOINT: 'http://orchestrator:8080',
	HANSI_SANDBOX_IMAGE: 'appwrite/hansi-toolchain:1',
	HANSI_REVIEW_MODEL: 'provider/model'
};

describe('parseEnv', () => {
	test('applies defaults', () => {
		const env = parseEnv(required);

		expect(env.HANSI_PORT).toBe(8080);
		expect(env.HANSI_CONCURRENCY).toBe(4);
		expect(env.HANSI_APPWRITE_QUEUE).toBe('v1-reviews');
	});

	test('names every missing variable', () => {
		expect(() => parseEnv({})).toThrow(
			/HANSI_APPWRITE_ENDPOINT[\s\S]*HANSI_SANDBOX_IMAGE[\s\S]*HANSI_REVIEW_MODEL/
		);
	});
});
