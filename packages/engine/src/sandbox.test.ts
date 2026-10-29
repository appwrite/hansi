import { expect, test } from 'bun:test';
import {
	createSandboxTools,
	formatCommandResult,
	MAX_COMMANDS,
	truncateOutput,
	type CommandRunner
} from './sandbox';
import type { ReviewEvent } from './tools';

const run = (tools: ReturnType<typeof createSandboxTools>, input: object) =>
	tools.run_command.execute!(
		input as never,
		{ toolCallId: 't', messages: [] } as never
	) as Promise<string>;

test('run_command passes the command and timeout to the runner and formats the result', async () => {
	const calls: { command: string; timeoutMs: number }[] = [];
	const events: ReviewEvent[] = [];
	const runner: CommandRunner = {
		run: async (command, { timeoutMs }) => {
			calls.push({ command, timeoutMs });
			return { exitCode: 1, stdout: '1 failed\n', stderr: '', timedOut: false };
		}
	};
	const tools = createSandboxTools(runner, (event) => events.push(event));

	const output = await run(tools, { command: 'bun test src/math.test.ts', timeoutSeconds: 30 });

	expect(calls).toEqual([{ command: 'bun test src/math.test.ts', timeoutMs: 30_000 }]);
	expect(output).toBe('Exit code 1\n\nstdout:\n1 failed');
	expect(events[0]).toMatchObject({
		type: 'tool.run_command',
		data: { command: 'bun test src/math.test.ts', exitCode: 1, timedOut: false }
	});
});

test('run_command reports a runner error once, then stops calling the runner', async () => {
	let calls = 0;
	const runner: CommandRunner = {
		run: async () => {
			calls++;
			throw new Error('The sandbox was stopped.');
		}
	};
	const tools = createSandboxTools(runner, () => {});

	expect(await run(tools, { command: 'go test ./...' })).toBe(
		'Error: The sandbox was stopped. run_command will not work again here; continue with the read-only tools.'
	);
	expect(await run(tools, { command: 'git log' })).toStartWith('Not run: The sandbox was stopped.');
	expect(calls).toBe(1);
});

test('run_command stops running commands once its budget is used up', async () => {
	let calls = 0;
	const runner: CommandRunner = {
		run: async () => {
			calls++;
			return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
		}
	};
	const tools = createSandboxTools(runner, () => {});
	for (let i = 0; i < MAX_COMMANDS; i++) await run(tools, { command: 'true' });

	expect(await run(tools, { command: 'true' })).toStartWith('Not run: the budget');
	expect(calls).toBe(MAX_COMMANDS);
});

test('formatCommandResult names timeouts and empty output', () => {
	expect(formatCommandResult({ exitCode: null, stdout: '', stderr: '', timedOut: true })).toBe(
		'Timed out\n\nNo output.'
	);
	expect(formatCommandResult({ exitCode: 0, stdout: '', stderr: 'warn\n', timedOut: false })).toBe(
		'Exit code 0\n\nstderr:\nwarn'
	);
});

test('truncateOutput keeps the start and the end', () => {
	const text = `${'a'.repeat(50)}${'b'.repeat(50)}`;
	const cut = truncateOutput(text, 20);
	expect(cut.startsWith('a'.repeat(10))).toBe(true);
	expect(cut.endsWith('b'.repeat(10))).toBe(true);
	expect(cut).toContain('80 characters cut');
	expect(truncateOutput('short', 20)).toBe('short');
});
