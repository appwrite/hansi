// In-memory adapters for tests. Not for production: nothing here survives a restart.

import { MockLanguageModelV4 } from 'ai/test';
import type {
	CheckRun,
	FailedCheck,
	GitHubClient,
	GitHubClientFactory,
	GitRemote,
	PullRequest,
	PullRequestFile,
	ReviewComment,
	SubmittedReview
} from './github';
import type { Job } from './jobs';
import type { JobSource, Lease } from './job-source';
import type { ModelUsage, ResultsSink, ReviewOutcome, ReviewRef, TraceEvent } from './results';
import type { CommandResult, Sandbox, SandboxClient, SandboxSpec } from './sandbox';

export type Settlement = { job: Job; result: 'ack' } | { job: Job; result: 'nack'; retry: boolean };

export class MemoryJobSource implements JobSource {
	readonly settled: Settlement[] = [];
	private readonly pending: Job[] = [];
	private readonly waiters: Array<(job: Job) => void> = [];

	push(...jobs: Job[]): void {
		for (const job of jobs) {
			const waiter = this.waiters.shift();
			if (waiter) waiter(job);
			else this.pending.push(job);
		}
	}

	async next(signal: AbortSignal): Promise<Lease | null> {
		if (signal.aborted) return null;
		const queued = this.pending.shift();
		if (queued) return this.lease(queued);

		return new Promise((resolve) => {
			const waiter = (job: Job) => {
				signal.removeEventListener('abort', onAbort);
				resolve(this.lease(job));
			};
			const onAbort = () => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				resolve(null);
			};
			this.waiters.push(waiter);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private lease(job: Job): Lease {
		return {
			job,
			attempts: 0,
			maxAttempts: 3,
			ack: async () => {
				this.settled.push({ job, result: 'ack' });
			},
			nack: async ({ retry }) => {
				this.settled.push({ job, result: 'nack', retry });
			}
		};
	}
}

export type SinkCall =
	| { method: 'startReview'; review: ReviewRef; headSha: string; baseSha: string }
	| { method: 'recordEvents'; review: ReviewRef; events: TraceEvent[] }
	| { method: 'recordUsage'; review: ReviewRef; usage: ModelUsage[] }
	| { method: 'completeReview'; review: ReviewRef; outcome: ReviewOutcome }
	| { method: 'skipReview'; review: ReviewRef; reason: string }
	| { method: 'failReview'; review: ReviewRef; reason: string };

export class MemoryResultsSink implements ResultsSink {
	readonly calls: SinkCall[] = [];

	async startReview(review: ReviewRef, input: { headSha: string; baseSha: string }) {
		this.calls.push({ method: 'startReview', review, ...input });
	}

	async recordEvents(review: ReviewRef, events: TraceEvent[]) {
		this.calls.push({ method: 'recordEvents', review, events });
	}

	async recordUsage(review: ReviewRef, usage: ModelUsage[]) {
		this.calls.push({ method: 'recordUsage', review, usage });
	}

	async completeReview(review: ReviewRef, outcome: ReviewOutcome) {
		this.calls.push({ method: 'completeReview', review, outcome });
	}

	async skipReview(review: ReviewRef, reason: string) {
		this.calls.push({ method: 'skipReview', review, reason });
	}

	async failReview(review: ReviewRef, reason: string) {
		this.calls.push({ method: 'failReview', review, reason });
	}
}

/** One model response: text that ends the turn, or tool calls. */
export type ScriptedTurn = { text: string } | { calls: { tool: string; input: unknown }[] };

/**
 * A model that replays `turns` in order, one per call, and throws when they run out. Its
 * `doGenerateCalls` show what each call was sent.
 */
export function scriptedModel(turns: ScriptedTurn[]): MockLanguageModelV4 {
	let next = 0;
	return new MockLanguageModelV4({
		provider: 'scripted',
		modelId: 'scripted-model',
		doGenerate: async () => {
			const turn = turns[next++];
			if (!turn) throw new Error(`The script has no turn ${next}`);
			const usage = {
				inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 },
				outputTokens: { total: 10, text: 8, reasoning: 2 }
			};
			if ('text' in turn) {
				return {
					content: [{ type: 'text', text: turn.text }],
					finishReason: { unified: 'stop', raw: undefined },
					usage,
					warnings: []
				};
			}
			return {
				content: turn.calls.map((call, i) => ({
					type: 'tool-call' as const,
					toolCallId: `call-${next}-${i}`,
					toolName: call.tool,
					input: JSON.stringify(call.input)
				})),
				finishReason: { unified: 'tool-calls', raw: undefined },
				usage,
				warnings: []
			};
		}
	});
}

/** A GitHub repository in memory, with one pull request. Records what the engine posts. */
export class MemoryGitHub implements GitHubClient, GitHubClientFactory {
	readonly reviews: { pullNumber: number; review: Parameters<GitHubClient['createReview']>[1] }[] =
		[];
	readonly checkRuns: CheckRun[] = [];
	/** Set to make check runs fail, as for an installation without the permission. */
	checksForbidden = false;

	constructor(
		public pullRequest: PullRequest,
		public files: PullRequestFile[],
		private readonly remote: GitRemote
	) {}

	async forRepository(): Promise<GitHubClient> {
		return this;
	}

	async gitRemote(): Promise<GitRemote> {
		return this.remote;
	}

	async getPullRequest(): Promise<PullRequest> {
		return this.pullRequest;
	}

	async listPullRequestFiles(): Promise<PullRequestFile[]> {
		return this.files;
	}

	async getArchiveUrl(ref: string): Promise<string> {
		return `memory://archive/${ref}`;
	}

	async listFailedChecks(): Promise<FailedCheck[]> {
		return [];
	}

	async listReviews(): Promise<SubmittedReview[]> {
		return this.reviews.map(({ review }, i) => ({
			id: i + 1,
			body: review.body,
			commitId: review.commitId,
			url: `memory://review/${i + 1}`
		}));
	}

	async listReviewComments(): Promise<ReviewComment[]> {
		return [];
	}

	async createReview(
		pullNumber: number,
		review: Parameters<GitHubClient['createReview']>[1]
	): Promise<{ id: number; url: string }> {
		this.reviews.push({ pullNumber, review });
		return { id: this.reviews.length, url: `memory://review/${this.reviews.length}` };
	}

	async replyToReviewComment(): Promise<{ id: number }> {
		throw new Error('MemoryGitHub.replyToReviewComment is not implemented');
	}

	async resolveThread(): Promise<void> {
		throw new Error('MemoryGitHub.resolveThread is not implemented');
	}

	async createIssueComment(): Promise<{ id: number; url: string }> {
		throw new Error('MemoryGitHub.createIssueComment is not implemented');
	}

	async updateIssueComment(): Promise<void> {
		throw new Error('MemoryGitHub.updateIssueComment is not implemented');
	}

	async addReaction(): Promise<void> {}

	async createCheckRun(run: CheckRun): Promise<{ id: number }> {
		if (this.checksForbidden) throw new Error('Resource not accessible by integration');
		this.checkRuns.push({ ...run });
		return { id: this.checkRuns.length - 1 };
	}

	async updateCheckRun(id: number, run: Partial<CheckRun>): Promise<void> {
		Object.assign(this.checkRuns[id]!, run);
	}
}

/** Answers one command in a `MemorySandboxes` sandbox. */
export type CommandHandler = (command: string) => CommandResult | Promise<CommandResult>;

/** Sandboxes that answer commands with `handler` and record what they were asked. */
export class MemorySandboxes implements SandboxClient {
	readonly created: SandboxSpec[] = [];
	readonly commands: string[] = [];
	closed = 0;

	constructor(
		private readonly handler: CommandHandler = () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
			timedOut: false,
			truncated: false
		})
	) {}

	async create(spec: SandboxSpec): Promise<Sandbox> {
		this.created.push(spec);
		const id = `sandbox-${this.created.length}`;
		return {
			id,
			run: async (command) => {
				this.commands.push(command);
				return this.handler(command);
			},
			close: async () => {
				this.closed++;
			}
		};
	}
}
