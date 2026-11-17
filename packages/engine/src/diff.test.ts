import { expect, test } from 'bun:test';
import { splitPatches } from './diff';

test("splitPatches gives each file's hunks the way GitHub's files API does", () => {
	const diff = [
		'diff --git a/src/a.ts b/src/a.ts',
		'index 1111111..2222222 100644',
		'--- a/src/a.ts',
		'+++ b/src/a.ts',
		'@@ -1,2 +1,2 @@',
		' keep',
		'-old',
		'+new',
		'diff --git a/gone.ts b/gone.ts',
		'deleted file mode 100644',
		'--- a/gone.ts',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-bye',
		'diff --git a/logo.png b/logo.png',
		'Binary files a/logo.png and b/logo.png differ',
		'diff --git a/old name.ts b/new name.ts',
		'similarity index 100%',
		'rename from old name.ts',
		'rename to new name.ts',
		''
	].join('\n');

	expect(splitPatches(diff)).toEqual([
		{ path: 'src/a.ts', patch: '@@ -1,2 +1,2 @@\n keep\n-old\n+new' },
		{ path: 'gone.ts', patch: '@@ -1 +0,0 @@\n-bye' },
		{ path: 'logo.png' },
		{ path: 'new name.ts' }
	]);
});
