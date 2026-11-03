import { expect, test } from 'bun:test';
import { backgroundSandbox, lazySandbox, type ReviewSandbox } from './review-sandbox';

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
