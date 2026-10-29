import type { GitHubClientFactory } from './github';
import type { ResultsSink } from './results';
import type { ReviewModel } from './review';
import type { SandboxClient } from './sandboxes';

/** Where the engine logs. Fields are structured, never interpolated into the message. */
export interface Log {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

/** Everything the engine reaches outside itself. The service wires the production adapters. */
export interface EngineContext {
	github: GitHubClientFactory;
	/** Where the agents run commands. Without one, a review only reads the code. */
	sandboxes?: SandboxClient;
	results: ResultsSink;
	models: { review: ReviewModel; verify?: ReviewModel };
	log: Log;
	/** Whether the reviewer may start subagents. On unless turned off. */
	subagents?: boolean;
	/** Where checkouts go. Defaults to `hansi` in the system's temporary directory. */
	workdir?: string;
}

/** Which delivery of the job this is, counted from 1, and how many the queue allows. */
export interface Attempt {
	attempts: number;
	maxAttempts: number;
}
