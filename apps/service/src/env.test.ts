import { describe, expect, test } from 'bun:test';
import { parseEnv } from './env';

const required = {
	HANSI_APPWRITE_ENDPOINT: 'http://appwrite/v1',
	HANSI_APPWRITE_SECRET: 'secret',
	HANSI_QUEUE_URL: 'nats://hansi:secret@nats:4222',
	HANSI_ORCHESTRATOR_ENDPOINT: 'http://orchestrator:8080',
	HANSI_SANDBOX_IMAGE: 'appwrite/hansi-toolchain:1',
	HANSI_REVIEW_MODEL: 'provider/model'
};

describe('parseEnv', () => {
	test('applies defaults', () => {
		const env = parseEnv(required);

		expect(env.HANSI_PORT).toBe(8080);
		expect(env.HANSI_CONCURRENCY).toBe(4);
		expect(env.HANSI_QUEUE_NAME).toBe('v1-reviews');
	});

	test('takes a NATS or a Redis queue', () => {
		expect(parseEnv({ ...required, HANSI_QUEUE_URL: 'redis://redis:6379' }).HANSI_QUEUE_URL).toBe(
			'redis://redis:6379'
		);
		expect(() => parseEnv({ ...required, HANSI_QUEUE_URL: 'amqp://rabbit:5672' })).toThrow(
			/HANSI_QUEUE_URL/
		);
		expect(() => parseEnv({ ...required, HANSI_QUEUE_URL: 'nats:///' })).toThrow(/HANSI_QUEUE_URL/);
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

	test('puts separate queue credentials into the URL, escaped', () => {
		const env = parseEnv({
			...required,
			HANSI_QUEUE_URL: 'redis://redis:6379',
			HANSI_QUEUE_USER: 'default',
			HANSI_QUEUE_PASSWORD: 'p@ss:/?#%41'
		});
		const url = new URL(env.HANSI_QUEUE_URL);
		expect(url.host).toBe('redis:6379');
		expect(decodeURIComponent(url.username)).toBe('default');
		expect(decodeURIComponent(url.password)).toBe('p@ss:/?#%41');
		expect(
			parseEnv({ ...required, HANSI_QUEUE_USER: '', HANSI_QUEUE_PASSWORD: '' }).HANSI_QUEUE_URL
		).toBe(required.HANSI_QUEUE_URL);
	});

	test('names every missing variable', () => {
		expect(() => parseEnv({})).toThrow(
			/HANSI_APPWRITE_ENDPOINT[\s\S]*HANSI_QUEUE_URL[\s\S]*HANSI_REVIEW_MODEL/
		);
	});
});
