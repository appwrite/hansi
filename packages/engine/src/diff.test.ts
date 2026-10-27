import { describe, expect, test } from 'bun:test';
import {
	commentableLines,
	hunkOf,
	parseGitDiff,
	parseGitHubFile,
	renderExcerpt,
	renderFileDiff
} from './diff';

const gitDiff = [
	'diff --git a/src/app.ts b/src/app.ts',
	'index 1111111..2222222 100644',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,4 +1,5 @@ export function main() {',
	' const a = 1;',
	'-const b = 2;',
	'+const b = 3;',
	'+const c = 4;',
	' ',
	' return a + b;',
	'@@ -20,2 +21,2 @@',
	'--- removed sql comment',
	'+-- added sql comment',
	' end',
	'diff --git a/docs/old.md b/docs/new.md',
	'similarity index 90%',
	'rename from docs/old.md',
	'rename to docs/new.md',
	'diff --git a/logo.png b/logo.png',
	'new file mode 100644',
	'index 0000000..3333333',
	'Binary files /dev/null and b/logo.png differ',
	'diff --git a/gone.txt b/gone.txt',
	'deleted file mode 100644',
	'--- a/gone.txt',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-bye',
	'\\ No newline at end of file',
	''
].join('\n');

describe('parseGitDiff', () => {
	const files = parseGitDiff(gitDiff);

	test('reads every file with its status', () => {
		expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
			['src/app.ts', 'modified', false],
			['docs/new.md', 'renamed', false],
			['logo.png', 'added', true],
			['gone.txt', 'deleted', false]
		]);
		expect(files[1]?.oldPath).toBe('docs/old.md');
	});

	test('numbers new-file lines and counts changes', () => {
		const app = files[0]!;

		expect(app.additions).toBe(3);
		expect(app.deletions).toBe(2);
		expect(app.hunks[0]?.lines.map((l) => [l.type, l.line])).toEqual([
			['context', 1],
			['del', undefined],
			['add', 2],
			['add', 3],
			['context', 4],
			['context', 5]
		]);
	});

	test('keeps a removed line that looks like a file header as content', () => {
		expect(files[0]?.hunks[1]?.lines.map((l) => [l.type, l.text])).toEqual([
			['del', '-- removed sql comment'],
			['add', '-- added sql comment'],
			['context', 'end']
		]);
	});

	test('skips the no-newline marker', () => {
		expect(files[3]?.hunks[0]?.lines).toEqual([{ type: 'del', text: 'bye' }]);
	});
});

describe('parseGitHubFile', () => {
	test('reads a patch without file headers', () => {
		const file = parseGitHubFile({
			path: 'a.ts',
			status: 'modified',
			patch: '@@ -5,2 +5,3 @@\n x\n+y\n z'
		});

		expect([...commentableLines(file)]).toEqual([5, 6, 7]);
	});

	test('treats a missing patch as binary', () => {
		expect(parseGitHubFile({ path: 'a.png', status: 'added' })).toMatchObject({
			status: 'added',
			binary: true,
			hunks: []
		});
	});

	test('maps GitHub statuses', () => {
		const file = parseGitHubFile({
			path: 'b.ts',
			previousPath: 'a.ts',
			status: 'renamed',
			patch: ''
		});

		expect(file.status).toBe('renamed');
		expect(file.oldPath).toBe('a.ts');
		expect(parseGitHubFile({ path: 'c.ts', status: 'removed' }).status).toBe('deleted');
	});
});

describe('rendering', () => {
	const app = parseGitDiff(gitDiff)[0]!;

	test('prints new-file line numbers in front of each line', () => {
		expect(renderFileDiff(app).split('\n').slice(0, 4)).toEqual([
			'### src/app.ts [modified, +3 -2]',
			'@@ -1,4 +1,5 @@ export function main() {',
			'    1   const a = 1;',
			'      - const b = 2;'
		]);
	});

	test('finds the hunk of a line', () => {
		expect(hunkOf(app, 3)).toBe(0);
		expect(hunkOf(app, 21)).toBe(1);
		expect(hunkOf(app, 100)).toBe(-1);
	});

	test('cuts an excerpt around the lines', () => {
		const excerpt = renderExcerpt(app, 3, 3, 1);

		expect(excerpt?.split('\n').slice(2)).toEqual([
			'    2 + const b = 3;',
			'    3 + const c = 4;',
			'    4   '
		]);
		expect(renderExcerpt(app, 100, 101)).toBeNull();
	});
});
