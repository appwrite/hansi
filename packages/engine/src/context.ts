import type { GitHubClientFactory } from './github';
import type { ResultsSink } from './results';
import type { SandboxClient } from './sandbox';

/** Everything the engine reaches outside itself. The service wires the production adapters. */
export interface EngineContext {
	github: GitHubClientFactory;
	/** Where the agents run commands. Without one, a review only reads the code. */
	sandboxes?: SandboxClient;
	results: ResultsSink;
}
