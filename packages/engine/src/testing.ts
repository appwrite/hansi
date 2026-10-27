// In-memory adapters for tests. Not for production: nothing here survives a restart.

import { MockLanguageModelV4 } from 'ai/test';
import type {
	CheckRun,
	FailedCheck,
	GitHubClient,
	GitHubClientFactory,
	GitRemote,
	IssueComment,
	PullRequest,
	PullRequestFile,
	Reaction,
	ReviewComment,
	SubmittedReview
} from './github';
import type {
	ChatRef,
	ModelUsage,
	ResultsSink,
	ReviewOutcome,
	ReviewRef,
	TraceEvent
} from './results';
import type { CommandResult, Sandbox, SandboxClient, SandboxSpec } from './sandbox';

export type SinkCall =
	| { method: 'startReview'; review: ReviewRef; headSha: string; baseSha: string }
	| { method: 'recordEvents'; review: ReviewRef; events: TraceEvent[] }
	| { method: 'recordUsage'; review: ReviewRef; usage: ModelUsage[] }
	| { method: 'completeReview'; review: ReviewRef; outcome: ReviewOutcome }
	| { method: 'skipReview'; review: ReviewRef; reason: string }
	| { method: 'failReview'; review: ReviewRef; reason: string }
	| { method: 'recordChatUsage'; chat: ChatRef; usage: ModelUsage[] };

export class MemoryResultsSink implements ResultsSink {
	readonly calls: SinkCall[] = [];
	/** Set to answer `startReview` as for a review that already ended. */
	ended = false;

	async startReview(review: ReviewRef, input: { headSha: string; baseSha: string }) {
		this.calls.push({ method: 'startReview', review, ...input });
		return !this.ended;
	}

	async recordEvents(review: ReviewRef, events: TraceEvent[]) {
		this.calls.push({ method: 'recordEvents', review, events: events.splice(0) });
	}

	async recordUsage(review: ReviewRef, usage: ModelUsage[]) {
		this.calls.push({ method: 'recordUsage', review, usage: usage.splice(0) });
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

	async recordChatUsage(chat: ChatRef, usage: ModelUsage[]) {
		this.calls.push({ method: 'recordChatUsage', chat, usage: usage.splice(0) });
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
	/** `bot: false` for a review a person posted; the ones created here are the app's. */
	readonly reviews: {
		pullNumber: number;
		review: Parameters<GitHubClient['createReview']>[1];
		bot?: boolean;
	}[] = [];
	/** Review comments, replies included. Add a person's with `bot: false`. */
	readonly reviewComments: ReviewComment[] = [];
	/** Comments on the conversation. Add a person's with `bot: false`. */
	readonly issueComments: IssueComment[] = [];
	readonly reactions: { comment: { id: number; kind: 'issue' | 'review' }; reaction: Reaction }[] =
		[];
	readonly checkRuns: CheckRun[] = [];
	/** Set to make check runs fail, as for an installation without the permission. */
	checksForbidden = false;
	private nextCommentId = 1000;

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
		return this.reviews.map(({ review, bot = true }, i) => ({
			id: i + 1,
			body: review.body,
			commitId: review.commitId,
			url: `memory://review/${i + 1}`,
			bot
		}));
	}

	async listReviewComments(): Promise<ReviewComment[]> {
		return this.reviewComments.map((comment) => ({ ...comment }));
	}

	async createReview(
		pullNumber: number,
		review: Parameters<GitHubClient['createReview']>[1]
	): Promise<{ id: number; url: string }> {
		this.reviews.push({ pullNumber, review });
		return { id: this.reviews.length, url: `memory://review/${this.reviews.length}` };
	}

	async replyToReviewComment(
		_pullNumber: number,
		commentId: number,
		body: string
	): Promise<{ id: number }> {
		const root = this.reviewComments.find((comment) => comment.id === commentId);
		if (!root) throw new Error(`No review comment ${commentId}`);
		const id = this.nextCommentId++;
		this.reviewComments.push({
			id,
			path: root.path,
			line: root.line,
			body,
			author: 'hansi[bot]',
			bot: true,
			inReplyToId: root.inReplyToId ?? root.id,
			url: `memory://comment/${id}`
		});
		return { id };
	}

	async resolveThread(): Promise<void> {
		throw new Error('MemoryGitHub.resolveThread is not implemented');
	}

	async listIssueComments(): Promise<IssueComment[]> {
		return this.issueComments.map((comment) => ({ ...comment }));
	}

	async createIssueComment(
		_issueNumber: number,
		body: string
	): Promise<{ id: number; url: string }> {
		const id = this.nextCommentId++;
		const url = `memory://comment/${id}`;
		this.issueComments.push({ id, body, author: 'hansi[bot]', bot: true, url });
		return { id, url };
	}

	async updateIssueComment(): Promise<void> {
		throw new Error('MemoryGitHub.updateIssueComment is not implemented');
	}

	async addReaction(
		comment: { id: number; kind: 'issue' | 'review' },
		reaction: Reaction
	): Promise<void> {
		this.reactions.push({ comment, reaction });
	}

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
