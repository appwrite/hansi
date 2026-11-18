import { describe, expect, test } from 'bun:test';
import { statusImagesOrigin } from './shared';

describe('statusImagesOrigin', () => {
	test('is the origin of the Appwrite host that serves the status images', () => {
		expect(
			statusImagesOrigin({ provider: 'github', imagesUrl: 'https://cloud.appwrite.io/' })
		).toBe('https://cloud.appwrite.io');
		for (const provider of ['gitlab', 'bitbucket', 'gitea'] as const) {
			expect(statusImagesOrigin({ provider, imagesUrl: 'http://localhost' })).toBe(
				'http://localhost'
			);
		}
	});

	test('is absent on Origin, when Appwrite names no host, or for one that is not a URL', () => {
		expect(
			statusImagesOrigin({ provider: 'origin', imagesUrl: 'https://cloud.appwrite.io/' })
		).toBeUndefined();
		expect(statusImagesOrigin({ provider: 'github' })).toBeUndefined();
		expect(statusImagesOrigin({ provider: 'github', imagesUrl: 'cloud' })).toBeUndefined();
	});
});
