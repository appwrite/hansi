import { describe, expect, test } from 'bun:test';
import { parseGitHubFile, type FileDiff } from './diff';
import { filterFiles, isLockfile } from './filters';

const changed = (path: string, status = 'modified'): FileDiff =>
	parseGitHubFile({ path, status, patch: '@@ -1 +1 @@\n-a\n+b' });

const paths = (files: FileDiff[]) => files.map((f) => f.path);

describe('filterFiles', () => {
	const files = [
		changed('src/index.ts'),
		changed('yarn.lock'),
		changed('packages/a/__snapshots__/x.ts.snap'),
		changed('dist/bundle.js'),
		changed('docs/guide.md'),
		parseGitHubFile({ path: 'img.png', status: 'added' }),
		parseGitHubFile({ path: 'old.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-a' })
	];

	test('skips lockfiles, generated output and noise by default', () => {
		const result = filterFiles(files);

		expect(paths(result.included)).toEqual(['src/index.ts', 'docs/guide.md']);
		expect(result.excluded).toContainEqual({ path: 'old.ts', reason: 'deleted' });
		expect(result.excluded).toContainEqual({ path: 'img.png', reason: 'binary' });
		expect(result.excluded).toContainEqual({ path: 'yarn.lock', reason: 'ignored' });
	});

	test('reviews what a sandbox can check', () => {
		expect(paths(filterFiles(files, [], { sandbox: true }).included)).toEqual([
			'src/index.ts',
			'yarn.lock',
			'packages/a/__snapshots__/x.ts.snap',
			'docs/guide.md'
		]);
	});

	test('applies exclusions and the allowlist', () => {
		expect(paths(filterFiles(files, ['!docs/**']).included)).toEqual(['src/index.ts']);
		expect(paths(filterFiles(files, ['src/**', 'dist/**']).included)).toEqual([
			'src/index.ts',
			'dist/bundle.js'
		]);
	});
});

test('isLockfile', () => {
	expect(isLockfile('composer.lock')).toBe(true);
	expect(isLockfile('web/package-lock.json')).toBe(true);
	expect(isLockfile('src/lock.ts')).toBe(false);
});
