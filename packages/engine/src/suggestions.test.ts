import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from './findings';
import { checkSuggestion } from './suggestions';

// The situation from a real review: lines 4-6 open two blocks in Go.
const initGo = `package cli

func initProject(dir, autoload string) error {
	if autoload != "" {
		autoloadDir := filepath.Join(dir, filepath.Clean(autoload))
		if err := os.MkdirAll(autoloadDir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
`;

let repoDir: string;
beforeAll(async () => {
	repoDir = await mkdtemp(join(tmpdir(), 'hans-suggest-'));
	await mkdir(join(repoDir, 'internal/cli'), { recursive: true });
	await writeFile(join(repoDir, 'internal/cli/init.go'), initGo);
	await writeFile(join(repoDir, 'notes.txt'), 'hello\n');
});
afterAll(() => rm(repoDir, { recursive: true, force: true }));

const finding = (suggestion: string, path = 'internal/cli/init.go'): Finding => ({
	path,
	startLine: 4,
	endLine: 6,
	severity: 'minor',
	category: 'bug',
	title: 'Init creates the autoload directory before detecting an existing manifest',
	body: 'Explained.',
	suggestion
});

describe('checkSuggestion', () => {
	test('rejects prose that would replace code', async () => {
		const result = await checkSuggestion(
			repoDir,
			finding(
				'Check for an existing manifest before creating the autoload directory, while retaining the later `O_EXCL` open to protect against concurrent creation.'
			)
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('syntax error');
	});

	test('rejects code that leaves blocks unclosed', async () => {
		const result = await checkSuggestion(repoDir, finding('\tif autoload != "" && !exists {'));
		expect(result.ok).toBe(false);
	});

	test('accepts a complete replacement for the lines', async () => {
		const replacement = [
			'\tif autoload != "" && !manifestExists(dir) {',
			'\t\tautoloadDir := filepath.Join(dir, filepath.Clean(autoload))',
			'\t\tif err := os.MkdirAll(autoloadDir, 0o755); err != nil {'
		].join('\n');
		expect(await checkSuggestion(repoDir, finding(replacement))).toEqual({ ok: true });
	});

	test('rejects suggestions that change nothing', async () => {
		const unchanged = initGo.split('\n').slice(3, 6).join('\n');
		expect((await checkSuggestion(repoDir, finding(unchanged))).ok).toBe(false);
	});

	test('cannot syntax-check unknown languages, so it allows them', async () => {
		const result = await checkSuggestion(repoDir, {
			...finding('bye'),
			path: 'notes.txt',
			startLine: 1,
			endLine: 1
		});
		expect(result).toEqual({ ok: true });
	});
});
