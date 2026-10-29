import type { RepoConfig } from './config';
import type { Log } from './context';
import type { CommandResult, CommandRunner } from './sandbox';
import type { SandboxClient } from './sandboxes';
import type { EmitEvent } from './tools';

// The sandbox a review or a reply runs commands in, on the open-runtimes orchestrator. It holds
// the pull request head and no credentials; the repository's setup command runs once it is up.

const SETUP_TIMEOUT_MS = 10 * 60_000;
/** The orchestrator deletes the sandbox after this long without a command, if close never comes. */
const IDLE_TIMEOUT_SECONDS = 60 * 60;
/** How long closing waits for the orchestrator, so a job settles even when it does not answer. */
const CLOSE_TIMEOUT_MS = 30_000;

export interface ReviewSandbox {
	runner: CommandRunner;
	close(): Promise<void>;
}

export interface OpenSandboxOptions {
	client: SandboxClient;
	/** A short-lived URL to a tarball of the pull request head. */
	archiveUrl: string;
	config: RepoConfig;
	emit: EmitEvent;
	log: Log;
}

/** Runs the repository's setup command, if it has one. A failed setup still leaves a usable sandbox. */
async function runSetup(
	config: RepoConfig,
	run: (command: string, timeoutMs: number) => Promise<CommandResult>,
	emit: EmitEvent
): Promise<void> {
	if (!config.sandbox.setup.trim()) return;
	const setup = await run(config.sandbox.setup, SETUP_TIMEOUT_MS);
	// The model sees the failure itself.
	emit({
		type: 'sandbox.setup',
		data: { command: config.sandbox.setup, exitCode: setup.exitCode, timedOut: setup.timedOut }
	});
}

/** Starts a sandbox of the pull request head and runs the setup command in it. */
export async function openSandbox(options: OpenSandboxOptions): Promise<ReviewSandbox> {
	const { client, config, emit, log } = options;
	const started = Date.now();
	const sandbox = await client.create({
		archiveUrl: options.archiveUrl,
		environment: { CI: 'true' },
		idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS
	});

	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)));
		await Promise.race([
			sandbox.close().catch((error: unknown) => {
				log.warn('sandbox delete failed', { err: error, id: sandbox.id });
			}),
			timeout
		]).finally(() => clearTimeout(timer));
	};
	const run = async (command: string, timeoutMs: number): Promise<CommandResult> => {
		const { exitCode, stdout, stderr, timedOut } = await sandbox.run(command, { timeoutMs });
		return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
	};

	try {
		emit({ type: 'sandbox.ready', data: { ms: Date.now() - started, id: sandbox.id } });
		await runSetup(config, run, emit);
	} catch (error) {
		await close();
		throw error;
	}

	return { runner: { run: (command, { timeoutMs }) => run(command, timeoutMs) }, close };
}

/**
 * A sandbox that starts on its first command, for replies that usually need none. If it cannot
 * start, that command and every later one fail with the reason.
 */
export function lazySandbox(open: () => Promise<ReviewSandbox>): ReviewSandbox {
	let opening: Promise<ReviewSandbox> | undefined;
	return {
		runner: {
			run: async (command, options) => {
				opening ??= open();
				const sandbox = await opening.catch((error: unknown) => {
					throw new Error(`The sandbox could not start: ${(error as Error).message}`);
				});
				return sandbox.runner.run(command, options);
			}
		},
		close: async () => {
			const sandbox = await opening?.catch(() => undefined);
			await sandbox?.close();
		}
	};
}
