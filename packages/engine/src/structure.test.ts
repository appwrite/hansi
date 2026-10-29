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
