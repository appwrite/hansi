import { describe, expect, test } from 'bun:test';
import { statusImagesOrigin } from './shared';

describe('statusImagesOrigin', () => {
	test("is the Console's origin, where Appwrite serves the status images", () => {
		expect(
			statusImagesOrigin({ provider: 'github', consoleUrl: 'https://cloud.appwrite.io/console' })
		).toBe('https://cloud.appwrite.io');
		for (const provider of ['gitlab', 'bitbucket', 'gitea'] as const) {
			expect(statusImagesOrigin({ provider, consoleUrl: 'http://localhost/console/' })).toBe(
				'http://localhost'
			);
		}
	});

	test('is absent on Origin, without a Console, or for a root that is not a URL', () => {
		expect(
			statusImagesOrigin({ provider: 'origin', consoleUrl: 'https://cloud.appwrite.io/console' })
		).toBeUndefined();
		expect(statusImagesOrigin({ provider: 'github' })).toBeUndefined();
		expect(statusImagesOrigin({ provider: 'github', consoleUrl: 'console' })).toBeUndefined();
	});
});
