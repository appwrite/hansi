import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRepoConfig } from './config';
import { git } from './git';
import {
	archiveCheckout,
	backgroundSandbox,
	lazySandbox,
	openSandbox,
	type ReviewSandbox
} from './review-sandbox';
import { MemorySandboxes } from './testing';

function fakeSandbox() {
	const state = { commands: [] as string[], closed: 0 };
	const sandbox: ReviewSandbox = {
		runner: {
			run: async (command) => {
				state.commands.push(command);
				return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
			}
		},
		close: async () => {
			state.closed++;
		}
	};
	return { state, sandbox };
}

test('a background sandbox starts at once and its first command waits for it', async () => {
	const { state, sandbox } = fakeSandbox();
	let opens = 0;
	let ready!: () => void;
	const opened = new Promise<void>((resolve) => (ready = resolve));
	const background = backgroundSandbox(async () => {
		opens++;
		await opened;
		return sandbox;
	});
	expect(opens).toBe(1);

	const result = background.runner.run('bun test', { timeoutMs: 1000 });
	await Promise.resolve();
	expect(state.commands).toEqual([]);
	ready();
	expect((await result).stdout).toBe('ok');
	await background.runner.run('bun run check', { timeoutMs: 1000 });
	expect(opens).toBe(1);
	expect(state.commands).toEqual(['bun test', 'bun run check']);

	await background.close();
	expect(state.closed).toBe(1);
});

test('a background sandbox that cannot start fails every command with the reason', async () => {
	const background = backgroundSandbox(async () => {
		throw new Error('orchestrator POST /v1/sandbox: 500');
	});
	const failure = 'The sandbox could not start: orchestrator POST /v1/sandbox: 500';
	await expect(background.runner.run('ls', { timeoutMs: 1000 })).rejects.toThrow(failure);
	await expect(background.runner.run('ls', { timeoutMs: 1000 })).rejects.toThrow(failure);
	await expect(background.close()).resolves.toBeUndefined();
});

test('closing a background sandbox that is still starting does not wait for it', async () => {
	const { state, sandbox } = fakeSandbox();
	let ready!: () => void;
	const opened = new Promise<void>((resolve) => (ready = resolve));
	const background = backgroundSandbox(async () => {
		await opened;
		return sandbox;
	});

	await background.close();
	expect(state.closed).toBe(0);
	ready();
	await opened;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(state.closed).toBe(1);
});

test('a lazy sandbox starts only on its first command', async () => {
	const { state, sandbox } = fakeSandbox();
	let opens = 0;
	const lazy = lazySandbox(async () => {
		opens++;
		return sandbox;
	});
	await lazy.close();
	expect(opens).toBe(0);

	await lazy.runner.run('ls', { timeoutMs: 1000 });
	await lazy.runner.run('pwd', { timeoutMs: 1000 });
	expect(opens).toBe(1);
	expect(state.commands).toEqual(['ls', 'pwd']);
	await lazy.close();
	expect(state.closed).toBe(1);
});

async function repository(files: Record<string, string | Uint8Array>, executable: string[] = []) {
	const dir = await mkdtemp(join(tmpdir(), 'hansi-archive-'));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(dir, path, '..'), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	for (const path of executable) await chmod(join(dir, path), 0o755);
	const run = (...args: string[]) => git(args, { cwd: dir });
	await run('init', '--quiet');
	await run('add', '.');
	await run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
	return dir;
}

async function listArchive(path: string): Promise<string[]> {
	const proc = Bun.spawn(['tar', '-tvzf', path], { stdout: 'pipe' });
	return (await new Response(proc.stdout).text()).trim().split('\n');
}

test('the archive holds the text files, keeps modes, and leaves out binaries and large files', async () => {
	const dir = await repository(
		{
			'src/app.ts': 'export const answer = 42;\n',
			'bin/run.sh': '#!/bin/sh\necho run\n',
			'public/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]),
			'dump.sql': 'x'.repeat(2048)
		},
		['bin/run.sh']
	);
	const output = `${dir}.tar.gz`;
	try {
		const omitted = await archiveCheckout(dir, output, 1024);

		expect(omitted.sort()).toEqual(['dump.sql', 'public/logo.png']);
		const entries = await listArchive(output);
		const names = entries.map((line) => line.split(/\s+/).at(-1));
		expect(names).toContain('src/app.ts');
		expect(names).not.toContain('public/logo.png');
		expect(names).not.toContain('dump.sql');
		expect(entries.find((line) => line.endsWith('bin/run.sh'))).toStartWith('-rwx');
		expect(entries.find((line) => line.endsWith('src/app.ts'))).toStartWith('-rw-');
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(output, { force: true });
	}
});

test('opening a sandbox uploads the archive and removes it afterwards', async () => {
	const dir = await repository({ 'README.md': '# app\n' });
	const sandboxes = new MemorySandboxes();
	const uploaded: number[] = [];
	const client = {
		// The archive only lives until create returns, as the upload happens inside it.
		create: async (spec: Parameters<MemorySandboxes['create']>[0]) => {
			uploaded.push((await (await spec.workspace).arrayBuffer()).byteLength);
			return sandboxes.create(spec);
		}
	};
	const events: string[] = [];
	try {
		const sandbox = await openSandbox({
			client,
			repoDir: dir,
			config: defaultRepoConfig,
			emit: (event) => events.push(event.type),
			log: { info() {}, warn() {} }
		});

		expect(sandboxes.created).toHaveLength(1);
		expect(uploaded[0]).toBeGreaterThan(0);
		expect(await Bun.file(`${dir}.sandbox.tar.gz`).exists()).toBe(false);
		expect(events).toEqual(['sandbox.ready']);
		await sandbox.close();
		expect(sandboxes.closed).toBe(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
