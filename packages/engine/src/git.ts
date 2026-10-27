export class GitError extends Error {
	override readonly name = 'GitError';

	constructor(
		readonly args: string[],
		readonly exitCode: number,
		readonly stderr: string
	) {
		super(`git ${args[0]} exited with ${exitCode}: ${stderr.trim().slice(0, 500)}`);
	}
}

export interface GitOptions {
	cwd: string;
	/** Installation token. Sent as a header, so it never lands in `.git/config`. */
	token?: string;
	signal?: AbortSignal;
}

/** Runs git and returns its stdout. Never prompts for credentials. */
export async function git(args: string[], options: GitOptions): Promise<string> {
	const auth = options.token
		? [
				'-c',
				`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`
			]
		: [];
	const proc = Bun.spawn(['git', ...auth, ...args], {
		cwd: options.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		signal: options.signal,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
	return stdout;
}
