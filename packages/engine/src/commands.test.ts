import { describe, expect, test } from 'bun:test';
import { MAX_COMMANDS, SandboxSession } from './commands';
import { MemorySandboxes } from './testing';

const ok = (stdout = '') => ({
	exitCode: 0,
	stdout,
	stderr: '',
	timedOut: false,
	truncated: false
});

function session(sandboxes: MemorySandboxes, setup?: string) {
	const events: string[] = [];
	const opened = new SandboxSession(() => sandboxes.create({ archiveUrl: 'memory://head' }), {
		setup,
		emit: (type) => events.push(type)
	});
	return { opened, events };
}

describe('SandboxSession', () => {
	test('starts one sandbox on the first command and runs setup once', async () => {
		const sandboxes = new MemorySandboxes((command) => ok(`ran ${command}`));
		const { opened, events } = session(sandboxes, 'npm ci');

		expect(sandboxes.created).toHaveLength(0);
		const first = await opened.run('npm test', 60);
		await opened.run('npx tsc', 60);
		await opened.close();

		expect(sandboxes.created).toEqual([{ archiveUrl: 'memory://head' }]);
		expect(sandboxes.commands).toEqual(['npm ci', 'npm test', 'npx tsc']);
		expect(first).toBe('exit code 0\nstdout:\nran npm test');
		expect(sandboxes.closed).toBe(1);
		expect(events).toEqual([
			'sandbox.ready',
			'sandbox.setup',
			'tool.run_command',
			'tool.run_command'
		]);
	});

	test('reports a failed setup with the first command only', async () => {
		const sandboxes = new MemorySandboxes((command) =>
			command === 'npm ci'
				? { exitCode: 1, stdout: '', stderr: 'ERESOLVE', timedOut: false, truncated: false }
				: ok()
		);
		const { opened } = session(sandboxes, 'npm ci');

		const first = await opened.run('npm test', 60);
		const second = await opened.run('npm test', 60);

		expect(first).toContain('setup command (npm ci) failed');
		expect(first).toContain('ERESOLVE');
		expect(second).toBe('exit code 0');
	});

	test('reports a sandbox that does not start, without retrying it', async () => {
		let attempts = 0;
		const opened = new SandboxSession(async () => {
			attempts++;
			throw new Error('no capacity');
		});

		expect(await opened.run('npm test', 60)).toBe(
			'Error: the sandbox is not available: no capacity'
		);
		expect(await opened.run('npm test', 60)).toContain('no capacity');
		expect(attempts).toBe(1);
		await opened.close();
	});

	test('keeps the end of long output and says when a command timed out', async () => {
		const sandboxes = new MemorySandboxes(() => ({
			exitCode: null,
			stdout: `${'x'.repeat(20_000)}SUMMARY`,
			stderr: '',
			timedOut: true,
			truncated: false
		}));
		const { opened } = session(sandboxes);

		const output = await opened.run('npm test', 30);

		expect(output).toStartWith('timed out after 30s\nstdout:\n… 10007 earlier characters cut');
		expect(output).toEndWith('SUMMARY');
	});

	test('stops after the command budget', async () => {
		const sandboxes = new MemorySandboxes();
		const { opened } = session(sandboxes);

		for (let i = 0; i < MAX_COMMANDS; i++) await opened.run('true', 10);
		const over = await opened.run('true', 10);

		expect(over).toContain(`already ran ${MAX_COMMANDS} commands`);
		expect(sandboxes.commands).toHaveLength(MAX_COMMANDS);
	});

	test('closes nothing when no command ran', async () => {
		const sandboxes = new MemorySandboxes();

		await session(sandboxes).opened.close();

		expect(sandboxes.created).toHaveLength(0);
	});
});
