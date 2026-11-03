import { rm } from 'node:fs/promises';
import type { RepoConfig } from './config';
import type { Log } from './context';
import { git, GitError } from './git';
import type { CommandResult, CommandRunner } from './sandbox';
import type { Sandbox, SandboxClient } from './sandboxes';
import type { EmitEvent } from './tools';

// The sandbox a review or a reply runs commands in, on the open-runtimes orchestrator. It holds
// the pull request head, uploaded from the service's own checkout, and no credentials; the
// repository's setup command runs once it is up.

const SETUP_TIMEOUT_MS = 10 * 60_000;
/** The orchestrator deletes the sandbox after this long without a command, if close never comes. */
const IDLE_TIMEOUT_SECONDS = 60 * 60;
/** How long closing waits for the orchestrator, so a job settles even when it does not answer. */
const CLOSE_TIMEOUT_MS = 30_000;
/** Text files over this size stay out of the sandbox too: generated dumps and fixtures. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Room for the paths left out, which go to `git archive` as arguments. Past it, the smallest
 * binary files go into the archive after all.
 */
const MAX_OMITTED_CHARS = 512 * 1024;

export interface ReviewSandbox {
	runner: CommandRunner;
	close(): Promise<void>;
}

export interface OpenSandboxOptions {
	client: SandboxClient;
	/** The service's checkout of the pull request head. */
	repoDir: string;
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

/**
 * Writes the checkout at HEAD to a gzipped tar, without binary files or files over
 * `maxFileBytes`, and returns the paths it left out. Commands build, test and lint text, while
 * the images, videos and archives a repository carries can be most of its size (about 360 of
 * appwrite/appwrite's 500 MiB), and the sandbox is ready only once its upload is in.
 */
export async function archiveCheckout(
	repoDir: string,
	output: string,
	maxFileBytes = MAX_FILE_BYTES
): Promise<string[]> {
	// "<mode> <type> <object> <size>\t<path>"; the size is "-" for submodules. Symlinks stay in.
	const sizes = new Map<string, number>();
	const listing = await git(['ls-tree', '-r', '-l', '-z', 'HEAD'], { cwd: repoDir });
	for (const entry of listing.split('\0')) {
		const tab = entry.indexOf('\t');
		const [mode, , , size] = entry.slice(0, tab).trim().split(/\s+/);
		if (tab > 0 && mode !== '120000' && Number(size) > 0)
			sizes.set(entry.slice(tab + 1), Number(size));
	}
	// git grep -I skips binary files, so the files it lists are the text ones. Empty files match
	// nothing either, which is why only files with a size are candidates.
	const text = new Set(
		(
			await git(['grep', '-I', '-l', '-z', '-e', ''], { cwd: repoDir }).catch((error: unknown) => {
				if (error instanceof GitError && error.exitCode === 1) return '';
				throw error;
			})
		).split('\0')
	);

	const candidates = [...sizes]
		.filter(([path, size]) => size > maxFileBytes || !text.has(path))
		.sort((a, b) => b[1] - a[1]);
	const omitted: string[] = [];
	let chars = 0;
	for (const [path, size] of candidates) {
		chars += path.length + 20;
		if (chars > MAX_OMITTED_CHARS && size <= maxFileBytes) break;
		omitted.push(path);
	}
	// A tree, not a commit, so the archive carries no pax header with the commit id.
	await git(
		[
			'archive',
			'--format=tar.gz',
			// Fastest compression: the archive crosses a fast network once, and level 6 costs seconds.
			'-1',
			`--output=${output}`,
			'HEAD^{tree}',
			'--',
			'.',
			...omitted.map((path) => `:(exclude,literal)${path}`)
		],
		{ cwd: repoDir }
	);
	return omitted;
}

/** Starts a sandbox of the pull request head and runs the setup command in it. */
export async function openSandbox(options: OpenSandboxOptions): Promise<ReviewSandbox> {
	const { client, config, emit, log } = options;
	const started = Date.now();
	const archive = `${options.repoDir}.sandbox.tar.gz`;
	// The archive is written while the sandbox starts, and uploaded once both are done.
	const archiving = archiveCheckout(options.repoDir, archive);
	archiving.catch(() => undefined);
	let sandbox: Sandbox;
	let omitted: string[];
	try {
		sandbox = await client.create({
			workspace: archiving.then(() => Bun.file(archive)),
			environment: { CI: 'true' },
			idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS
		});
		omitted = await archiving;
	} finally {
		await archiving.catch(() => undefined);
		await rm(archive, { force: true });
	}

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
		emit({
			type: 'sandbox.ready',
			data: {
				ms: Date.now() - started,
				id: sandbox.id,
				omitted: omitted.length,
				omittedFiles: omitted.slice(0, 20)
			}
		});
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
	return pendingSandbox(
		() => (opening ??= open()),
		() => opening
	);
}

/**
 * A sandbox that starts now and is waited for only by the first command, so the work that needs
 * no commands is not held up by it. If it cannot start, every command fails with the reason.
 */
export function backgroundSandbox(open: () => Promise<ReviewSandbox>): ReviewSandbox {
	let opened: ReviewSandbox | undefined;
	const opening = open().then((sandbox) => (opened = sandbox));
	// A failure surfaces on the first command, or not at all when none runs.
	opening.catch(() => undefined);
	const { runner } = pendingSandbox(
		() => opening,
		() => opening
	);
	return {
		runner,
		// A review that ran no command does not wait for a sandbox still starting: it is closed
		// once it is up.
		close: async () => {
			if (opened) return opened.close();
			void opening.then((sandbox) => sandbox.close()).catch(() => undefined);
		}
	};
}

/** A sandbox still opening: commands wait for it, and closing closes it once it has opened. */
function pendingSandbox(
	open: () => Promise<ReviewSandbox>,
	started: () => Promise<ReviewSandbox> | undefined
): ReviewSandbox {
	return {
		runner: {
			run: async (command, options) => {
				const sandbox = await open().catch((error: unknown) => {
					throw new Error(`The sandbox could not start: ${(error as Error).message}`);
				});
				return sandbox.runner.run(command, options);
			}
		},
		close: async () => {
			const sandbox = await started()?.catch(() => undefined);
			await sandbox?.close();
		}
	};
}
