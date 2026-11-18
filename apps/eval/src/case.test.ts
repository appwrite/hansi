import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneUrl, loadCases } from './case';

const valid = {
	description: 'Missing await',
	repo: 'appwrite/hansi',
	pull: 12,
	base: 'a'.repeat(40),
	head: 'b'.repeat(40),
	pullRequest: { title: 'Fix things' },
	expected: {
		verdict: 'request_changes',
		findings: [{ id: 'await', path: 'src/x.ts', lines: [3, 4], issue: 'Not awaited.' }]
	}
};

describe('loadCases', () => {
	let root: string;
	const write = async (id: string, body: unknown, patch?: string) => {
		await mkdir(join(root, id));
		await writeFile(join(root, id, 'case.json'), JSON.stringify(body));
		if (patch) await writeFile(join(root, id, 'inject.patch'), patch);
	};

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'hansi-eval-cases-'));
	});
	afterAll(() => rm(root, { recursive: true, force: true }));

	test('reads cases with defaults and their patch, filtered by id', async () => {
		await write('a-plain', valid);
		await write('b-planted', valid, 'diff --git a/x b/x\n');
		const cases = await loadCases(root);
		expect(cases.map((c) => c.id)).toEqual(['a-plain', 'b-planted']);
		expect(cases[0]).toMatchObject({
			pullRequest: { title: 'Fix things', body: '', author: 'octocat' },
			linkedIssues: []
		});
		expect(cases[0]?.patch).toBeUndefined();
		expect(cases[1]?.patch).toBe(join(root, 'b-planted', 'inject.patch'));
		expect((await loadCases(root, ['planted'])).map((c) => c.id)).toEqual(['b-planted']);
	});

	test('names the case and every problem in it', async () => {
		const broken = await mkdtemp(join(tmpdir(), 'hansi-eval-cases-'));
		await mkdir(join(broken, 'bad'));
		await writeFile(
			join(broken, 'bad', 'case.json'),
			JSON.stringify({ ...valid, base: 'main', expected: { findings: [{ id: 'x' }] } })
		);
		const error = await loadCases(broken).catch((e: Error) => e);
		expect(String(error)).toContain('case bad is invalid');
		expect(String(error)).toContain('base: a full 40-character commit SHA');
		expect(String(error)).toContain('expected.findings.0.path');
		await rm(broken, { recursive: true, force: true });
	});

	test('rejects an expected finding listed twice', async () => {
		const twice = await mkdtemp(join(tmpdir(), 'hansi-eval-cases-'));
		const finding = valid.expected.findings[0];
		await mkdir(join(twice, 'dup'));
		await writeFile(
			join(twice, 'dup', 'case.json'),
			JSON.stringify({ ...valid, expected: { findings: [finding, finding] } })
		);
		expect(String(await loadCases(twice).catch((e: Error) => e))).toContain(
			'expected finding await is listed twice'
		);
		await rm(twice, { recursive: true, force: true });
	});
});

test('cloneUrl reads owner/name as GitHub and keeps URLs', () => {
	expect(cloneUrl('appwrite/hansi')).toBe('https://github.com/appwrite/hansi.git');
	expect(cloneUrl('file:///tmp/repo')).toBe('file:///tmp/repo');
});
