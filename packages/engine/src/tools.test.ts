import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoTools, lineWindow } from './tools';

async function* chunked(text: string, size: number) {
	const bytes = new TextEncoder().encode(text);
	for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

describe('lineWindow', () => {
	test('keeps the asked lines and counts them as split would, at any chunk size', async () => {
		const texts = ['', 'a', 'a\n', 'a\nb', 'one\ntwo\nthree\n', 'ü€\n\n😀x\ny'];
		for (const text of texts) {
			const all = text.split('\n');
			for (const size of [1, 2, 3, 7, 1024]) {
				for (const [start, end] of [
					[1, 1],
					[1, 400],
					[2, 3],
					[5, 9]
				] as const) {
					const window = await lineWindow(chunked(text, size), start, end);
					expect(window.total).toBe(all.length);
					expect(window.lines).toEqual(all.slice(start - 1, end));
				}
			}
		}
	});

	test('cuts a long line and holds no more than the window', async () => {
		async function* huge() {
			const line = `${'x'.repeat(1023)}\n`;
			for (let i = 0; i < 100_000; i++) yield line;
			yield 'y'.repeat(50_000);
		}
		const window = await lineWindow(huge(), 99_999, 100_001, 10);
		expect(window.total).toBe(100_001);
		expect(window.lines).toEqual(['x'.repeat(10), 'x'.repeat(10), 'y'.repeat(10)]);
	});
});

describe('grep', () => {
	const run = (dir: string, pattern: string) =>
		createRepoTools(dir, () => {}).grep.execute!({ pattern }, {
			toolCallId: 't',
			messages: []
		} as never);

	test('shows the first matches and counts the rest', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hansi-grep-'));
		for (let i = 0; i < 150; i++) await writeFile(join(dir, `f${i}.ts`), 'needle\n');

		const result = (await run(dir, 'needle')) as string;
		const [shown, more] = result.split('\n… ');
		expect(shown!.split('\n')).toHaveLength(100);
		expect(shown!.split('\n').every((line) => line.endsWith(':1:needle'))).toBe(true);
		expect(more).toBe('50 more matches');
		expect(await run(dir, 'haystack')).toBe('No matches.');
	});

	test('shows every match when there are few', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hansi-grep-'));
		await writeFile(join(dir, 'a.ts'), 'one\nneedle\nneedle\n');
		expect(await run(dir, 'needle')).toBe('./a.ts:2:needle\n./a.ts:3:needle');
	});
});
