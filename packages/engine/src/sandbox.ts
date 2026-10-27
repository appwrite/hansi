// Command execution for the agent's run_command tool. The agent's read-only tools work on the
// service's own checkout; only commands run in a sandbox, where the code cannot reach the
// service or any credential.

export interface CommandResult {
	/** Null when the command did not exit on its own, e.g. it timed out. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Output went past the sandbox's cap and was cut. */
	truncated: boolean;
}

export interface Sandbox {
	readonly id: string;
	/** Runs `sh -c command` in a writable copy of the pull request head. */
	run(command: string, options: { timeoutMs: number }): Promise<CommandResult>;
	/** Tears the sandbox down. Safe to call more than once. */
	close(): Promise<void>;
}

export interface SandboxSpec {
	/** GitHub tarball of the pull request head, unpacked without its wrapper directory as the working directory. */
	archiveUrl: string;
	/** Environment for commands. Never credentials: the code under review can read it. */
	environment?: Record<string, string>;
	/** Torn down after this long without a command, in case `close` never comes. */
	idleTimeoutSeconds?: number;
}

export interface SandboxClient {
	create(spec: SandboxSpec): Promise<Sandbox>;
}
