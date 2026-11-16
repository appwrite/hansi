import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astSearch } from './structure';
import { createRepoTools } from './tools';

let repoDir: string;
beforeAll(async () => {
	repoDir = await mkdtemp(join(tmpdir(), 'hans-ast-'));
	await mkdir(join(repoDir, 'src'));
	await writeFile(
		join(repoDir, 'src/api.ts'),
		'export async function load(id: string) {\n  // fetch(later)\n  return fetch(`/items/${id}`);\n}\n'
	);
	await writeFile(join(repoDir, 'src/app.py'), 'def handler(event):\n    return save(event)\n');
	await writeFile(join(repoDir, 'main.go'), 'package main\n\nfunc main() {\n\tdb.Exec(query)\n}\n');
});
afterAll(() => rm(repoDir, { recursive: true, force: true }));

test('matches syntax, not text', async () => {
	const matches = await astSearch({
		repoDir,
		absolutePath: repoDir,
		language: 'TypeScript',
		pattern: 'fetch($$$)'
	});
	// The commented-out `fetch(later)` is not a call and must not match.
	expect(matches).toEqual([{ path: 'src/api.ts', line: 3, text: 'fetch(`/items/${id}`)' }]);
});

test('supports dynamically loaded languages', async () => {
	const python = await astSearch({
		repoDir,
		absolutePath: repoDir,
		language: 'python',
		pattern: 'def $F($$$): $$$'
	});
	expect(python.map((m) => `${m.path}:${m.line}`)).toEqual(['src/app.py:1']);

	// Go method calls don't parse as a standalone snippet; they need context and a selector.
	const go = await astSearch({
		repoDir,
		absolutePath: repoDir,
		language: 'go',
		pattern: '$DB.Exec($$$)',
		context: { snippet: 'func f() { $DB.Exec($$$) }', selector: 'call_expression' }
	});
	expect(go.map((m) => m.text)).toEqual(['db.Exec(query)']);
});

test('the ast_search tool formats matches and stays inside the repository', async () => {
	const tools = createRepoTools(repoDir, () => {});
	const run = (input: { pattern: string; language: 'TypeScript'; path: string }) =>
		tools.ast_search.execute!(input, { toolCallId: 't', messages: [] } as never);
	expect(await run({ pattern: 'fetch($$$)', language: 'TypeScript', path: 'src' })).toBe(
		'src/api.ts:3: fetch(`/items/${id}`)'
	);
	expect(await run({ pattern: 'fetch($$$)', language: 'TypeScript', path: '../' })).toStartWith(
		'Error: Path is outside the repository'
	);
});

test('a pattern that matches everything stops at the limit across batches of files', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'hans-ast-many-'));
	try {
		await Promise.all(
			Array.from({ length: 450 }, (_, i) =>
				writeFile(join(dir, `f${String(i).padStart(3, '0')}.ts`), `call${i}(1);\ncall${i}(2);\n`)
			)
		);
		const matches = await astSearch({
			repoDir: dir,
			absolutePath: dir,
			language: 'TypeScript',
			pattern: '$A($$$)',
			limit: 5
		});
		// ast-grep searches a batch in parallel, so which files come first varies; all of them are in
		// the first batch, because the search stops there.
		expect(matches).toHaveLength(5);
		expect(matches.every((m) => m.path < 'f200.ts')).toBe(true);

		// A match past the first batch of files is still found.
		const late = await astSearch({
			repoDir: dir,
			absolutePath: dir,
			language: 'TypeScript',
			pattern: 'call449($$$)'
		});
		expect(late.map((m) => m.path)).toEqual(['f449.ts', 'f449.ts']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('searches the tracked files of a checkout and a single file path', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'hans-ast-git-'));
	try {
		await mkdir(join(dir, 'src'));
		await mkdir(join(dir, 'dist'));
		await writeFile(join(dir, '.gitignore'), 'dist/\n');
		await writeFile(join(dir, 'src/a.ts'), 'fetch(a);\n');
		await writeFile(join(dir, 'src/b.ts'), 'fetch(b);\n');
		await writeFile(join(dir, 'dist/bundle.ts'), 'fetch(bundle);\n');
		const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
		expect(init.exitCode).toBe(0);
		Bun.spawnSync(['git', 'add', '.'], { cwd: dir });

		const search = (absolutePath: string) =>
			astSearch({ repoDir: dir, absolutePath, language: 'TypeScript', pattern: 'fetch($$$)' });
		expect((await search(dir)).map((m) => m.text)).toEqual(['fetch(a)', 'fetch(b)']);
		expect((await search(join(dir, 'src/b.ts'))).map((m) => m.text)).toEqual(['fetch(b)']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a single file outside a checkout is searched on its own', async () => {
	const matches = await astSearch({
		repoDir,
		absolutePath: join(repoDir, 'src/api.ts'),
		language: 'TypeScript',
		pattern: 'fetch($$$)'
	});
	expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/api.ts:3']);
});
