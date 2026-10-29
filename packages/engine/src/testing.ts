import type {
	CheckConclusion,
	GitHubApp,
	GitHubClient,
	GitHubClientFactory,
	GitHubConnection,
	PostedReviewComment,
	PullRequest,
	ReviewComment,
	ReviewEvent,
	ReviewThread,
	ThreadComment
} from './github';
import type {
	ChatRef,
	FindingRecord,
	FindingStatus,
	ModelUsage,
	PullRef,
	ResultsSink,
	ReviewOutcome,
	ReviewRecord,
	ReviewRef,
	TraceEvent
} from './results';
import type { Sandbox, SandboxClient, SandboxResult, SandboxSpec } from './sandboxes';
import type { Tier } from './config';

// In-memory stand-ins for the contracts, for tests here and in the adapters and the service.

/** Appwrite's Reviews API, kept in memory. Reviews belong to one pull request per test. */
export class MemoryResultsSink implements ResultsSink {
	readonly reviews: ReviewRecord[] = [];
	readonly findings: FindingRecord[] = [];
	readonly learnings: { body: string; author: string; sourceUrl: string }[] = [];
	readonly events: TraceEvent[] = [];
	readonly usage: ModelUsage[] = [];
	readonly chatUsage: { chat: ChatRef; usage: ModelUsage[] }[] = [];
	readonly skipped: { reviewId: string; reason: string }[] = [];
	readonly failed: { reviewId: string; reason: string }[] = [];
	private clock = 0;
	private ids = 0;

	/** Adds a queued review, as Appwrite does when a webhook arrives. */
	queue(review: Partial<ReviewRecord> & { id: string }): ReviewRecord {
		const record: ReviewRecord = {
			status: 'queued',
			trigger: 'opened',
			headSha: '',
			summary: '',
			tierReason: '',
			walkthrough: [],
			...review
		};
		this.reviews.unshift(record);
		return record;
	}

	review(id: string): ReviewRecord | undefined {
		return this.reviews.find((review) => review.id === id);
	}

	async listReviews(_pull: PullRef): Promise<ReviewRecord[]> {
		return this.reviews.map((review) => ({ ...review }));
	}

	async listFindings(_pull: PullRef, options: { limit?: number } = {}): Promise<FindingRecord[]> {
		const completed = new Set(
			this.reviews.filter((review) => review.status === 'completed').map((review) => review.id)
		);
		return this.findings
			.filter((finding) => completed.has(finding.reviewId))
			.slice(0, options.limit ?? 200)
			.map((finding) => ({ ...finding }));
	}

	async updateFindings(
		_pull: PullRef,
		ids: string[],
		update: { status: FindingStatus; reason: string; from?: FindingStatus }
	): Promise<void> {
		for (const finding of this.findings) {
			if (!ids.includes(finding.id)) continue;
			if (update.from && finding.status !== update.from) continue;
			finding.status = update.status;
			finding.dropReason = update.reason;
		}
	}

	async listLearnings(): Promise<string[]> {
		return this.learnings.map((learning) => learning.body);
	}

	async createLearning(
		_repository: { projectId: string; repositoryId: string },
		learning: { body: string; author: string; sourceUrl: string }
	): Promise<void> {
		this.learnings.push(learning);
	}

	async startReview(ref: ReviewRef, input: { headSha: string; baseSha: string }): Promise<boolean> {
		const review = this.review(ref.reviewId);
		if (!review) throw new Error(`review ${ref.reviewId} not found`);
		if (review.status !== 'queued' && review.status !== 'processing') return false;
		review.status = 'processing';
		review.headSha = input.headSha;
		return true;
	}

	async recordEvents(_ref: ReviewRef, events: TraceEvent[]): Promise<void> {
		this.events.push(...events.splice(0));
	}

	async recordUsage(_ref: ReviewRef, usage: ModelUsage[]): Promise<void> {
		this.usage.push(...usage.splice(0));
	}

	async completeReview(ref: ReviewRef, outcome: ReviewOutcome): Promise<void> {
		const review = this.end(ref, 'completed');
		review.verdict = outcome.verdict;
		review.tier = outcome.tier;
		review.tierReason = outcome.tierReason;
		review.summary = outcome.summary;
		review.walkthrough = outcome.walkthrough;
		for (const finding of outcome.findings) {
			this.findings.push({
				...finding,
				id: `finding-${++this.ids}`,
				reviewId: ref.reviewId,
				createdAt: new Date(this.clock).toISOString()
			});
		}
	}

	async updateGrade(ref: ReviewRef, grade: { tier: Tier; tierReason: string }): Promise<void> {
		const review = this.review(ref.reviewId);
		if (!review || review.status !== 'completed') throw new Error('review is not completed');
		review.tier = grade.tier;
		review.tierReason = grade.tierReason;
	}

	async skipReview(ref: ReviewRef, reason: string, headSha?: string): Promise<void> {
		const review = this.end(ref, 'skipped');
		review.summary = reason;
		if (headSha) review.headSha = headSha;
		this.skipped.push({ reviewId: ref.reviewId, reason });
	}

	async failReview(ref: ReviewRef, reason: string): Promise<void> {
		this.end(ref, 'failed');
		this.failed.push({ reviewId: ref.reviewId, reason });
	}

	async recordChatUsage(chat: ChatRef, usage: ModelUsage[]): Promise<void> {
		this.chatUsage.push({ chat, usage: usage.splice(0) });
	}

	private end(ref: ReviewRef, status: ReviewRecord['status']): ReviewRecord {
		const review = this.review(ref.reviewId) ?? this.queue({ id: ref.reviewId });
		if (review.status !== 'queued' && review.status !== 'processing') {
			throw new Error(`review ${ref.reviewId} is already ${review.status}`);
		}
		review.status = status;
		review.completedAt = new Date(++this.clock).toISOString();
		return review;
	}
}

export interface MemoryCheckRun {
	id: number;
	name: string;
	headSha: string;
	status: 'in_progress' | 'completed';
	conclusion?: CheckConclusion;
	title?: string;
	summary?: string;
	detailsUrl?: string;
	/** Every output it showed, in order. */
	outputs: { title: string; summary: string }[];
}

export interface MemoryReview {
	id: number;
	commitId: string;
	event: ReviewEvent;
	body: string;
	comments: ReviewComment[];
	state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
}

export interface MemoryIssueComment {
	id: number;
	body: string;
	author: string;
	isBot: boolean;
}

export interface MemoryReviewComment extends ThreadComment {
	inReplyToId?: number;
	reviewId?: number;
	subjectType?: 'file';
}

/**
 * One repository on GitHub, kept in memory: a pull request, its comments, reviews, threads and
 * check runs. Its factory returns itself for any repository.
 */
export class MemoryGitHub implements GitHubClient, GitHubClientFactory {
	readonly app: GitHubApp = { id: '123', slug: 'hansi' };
	readonly files = new Map<string, string>();
	readonly issueComments: MemoryIssueComment[] = [];
	readonly reviewComments: MemoryReviewComment[] = [];
	readonly reviews: MemoryReview[] = [];
	readonly checkRuns: MemoryCheckRun[] = [];
	readonly reactions: { id: number; kind: 'issue' | 'review' }[] = [];
	readonly resolved = new Set<number>();
	readonly writers = new Set<string>();
	/** Heads `getPullRequest` reports after the first read, in order, e.g. a push mid-review. */
	readonly nextHeads: string[] = [];
	private ids = 1000;

	constructor(public pullRequest: PullRequest) {}

	async forRepository(): Promise<GitHubConnection> {
		return { github: this, app: this.app };
	}

	async getInstallationToken(): Promise<string> {
		return '';
	}

	async getPullRequest(): Promise<PullRequest> {
		const next = this.nextHeads.shift();
		if (next) this.pullRequest = { ...this.pullRequest, headSha: next };
		return { ...this.pullRequest };
	}

	async isTrustedAuthor(pr: { author: string; authorAssociation: string }): Promise<boolean> {
		if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.authorAssociation)) return true;
		return this.hasWriteAccess(pr.author);
	}

	async hasWriteAccess(username: string): Promise<boolean> {
		return this.writers.has(username);
	}

	async getArchiveUrl(ref: string): Promise<string> {
		return `https://codeload.github.test/${ref}.tar.gz`;
	}

	async getFileContent(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async createReview(input: {
		pullNumber: number;
		commitId: string;
		body: string;
		comments: ReviewComment[];
		event: ReviewEvent;
	}): Promise<{ id: number }> {
		const id = ++this.ids;
		const state = {
			APPROVE: 'APPROVED',
			REQUEST_CHANGES: 'CHANGES_REQUESTED',
			COMMENT: 'COMMENTED'
		} as const;
		this.reviews.push({
			id,
			commitId: input.commitId,
			event: input.event,
			body: input.body,
			comments: input.comments,
			state: state[input.event]
		});
		for (const comment of input.comments) {
			this.reviewComments.push({
				id: ++this.ids,
				reviewId: id,
				author: `${this.app.slug}[bot]`,
				isBot: true,
				body: comment.body,
				path: comment.path,
				line: comment.line
			});
		}
		return { id };
	}

	async createFileComment(input: { path: string; body: string }): Promise<number> {
		const id = ++this.ids;
		this.reviewComments.push({
			id,
			author: `${this.app.slug}[bot]`,
			isBot: true,
			body: input.body,
			path: input.path,
			line: null,
			subjectType: 'file'
		});
		return id;
	}

	/** What GitHub's file list shows. Unset, the list fails, and findings stay where git put them. */
	patches?: { path: string; patch?: string }[];

	async listPullRequestPatches(): Promise<{ path: string; patch?: string }[]> {
		if (!this.patches) throw new Error('no file list');
		return this.patches;
	}

	async listReviewComments(_pullNumber: number, reviewId: number): Promise<PostedReviewComment[]> {
		return this.reviewComments
			.filter((comment) => comment.reviewId === reviewId)
			.map(({ id, path, line, body }) => ({ id, path: path ?? '', line, body }));
	}

	async dismissChangeRequests(
		_pullNumber: number,
		input: { botLogin: string; message: string }
	): Promise<number> {
		const open = this.reviews.filter((review) => review.state === 'CHANGES_REQUESTED');
		for (const review of open) review.state = 'DISMISSED';
		return input.botLogin ? open.length : 0;
	}

	async createIssueComment(_issueNumber: number, body: string): Promise<void> {
		this.issueComments.push({ id: ++this.ids, body, author: `${this.app.slug}[bot]`, isBot: true });
	}

	async updateIssueComment(commentId: number, body: string): Promise<void> {
		const comment = this.issueComments.find((c) => c.id === commentId);
		if (!comment) throw new Error(`comment ${commentId} not found`);
		comment.body = body;
	}

	async getMarkedComment(
		_issueNumber: number,
		marker: string
	): Promise<{ id: number; url: string; body: string } | null> {
		const comment = this.issueComments.find((c) => c.isBot && c.body.includes(marker));
		return comment ? { id: comment.id, url: this.urlOf(comment.id), body: comment.body } : null;
	}

	async upsertMarkedComment(
		issueNumber: number,
		marker: string,
		body: string
	): Promise<{ id: number; url: string }> {
		const existing = await this.getMarkedComment(issueNumber, marker);
		if (existing) {
			await this.updateIssueComment(existing.id, body);
			return { id: existing.id, url: existing.url };
		}
		await this.createIssueComment(issueNumber, body);
		const id = this.ids;
		return { id, url: this.urlOf(id) };
	}

	/** The summary comment's body, or null before the first write. */
	summary(marker = '<!-- hans:summary -->'): string | null {
		return this.issueComments.find((c) => c.isBot && c.body.includes(marker))?.body ?? null;
	}

	async acknowledgeComment(comment: { id: number; kind: 'issue' | 'review' }): Promise<void> {
		this.reactions.push(comment);
	}

	async getReviewThread(_pullNumber: number, rootCommentId: number): Promise<ThreadComment[]> {
		return this.reviewComments
			.filter((c) => c.id === rootCommentId || c.inReplyToId === rootCommentId)
			.map(({ inReplyToId: _, reviewId: __, subjectType: ___, ...comment }) => comment);
	}

	async getRecentIssueComments(_issueNumber: number, limit = 20): Promise<ThreadComment[]> {
		return this.issueComments.slice(-limit).map((comment) => ({ ...comment }));
	}

	async replyToReviewComment(_pullNumber: number, commentId: number, body: string): Promise<void> {
		this.reviewComments.push({
			id: ++this.ids,
			inReplyToId: commentId,
			author: `${this.app.slug}[bot]`,
			isBot: true,
			body
		});
	}

	async listReviewThreads(): Promise<ReviewThread[]> {
		return this.reviewComments
			.filter((comment) => comment.inReplyToId === undefined)
			.map((comment) => ({
				id: `thread-${comment.id}`,
				isResolved: this.resolved.has(comment.id),
				resolvedBy: this.resolved.has(comment.id)
					? (this.resolvedBy.get(comment.id) ?? null)
					: null,
				rootCommentId: comment.id
			}));
	}

	/** Who resolved a thread, by its root comment, when a person did. */
	readonly resolvedBy = new Map<number, string>();

	async resolveReviewThreads(_pullNumber: number, rootCommentIds: number[]): Promise<number> {
		let count = 0;
		for (const id of rootCommentIds) {
			if (this.resolved.has(id)) continue;
			this.resolved.add(id);
			this.resolvedBy.set(id, `${this.app.slug}[bot]`);
			count++;
		}
		return count;
	}

	async getLinkedIssues(): Promise<{ number: number; title: string; body: string }[]> {
		return [];
	}

	async getFailedChecks(): Promise<
		{ name: string; conclusion: string; output: string; annotations: [] }[]
	> {
		return [];
	}

	async startCheckRun(input: {
		headSha: string;
		name: string;
		detailsUrl?: string;
		output?: { title: string; summary: string };
	}): Promise<number> {
		const id = this.checkRuns.length + 1;
		this.checkRuns.push({
			id,
			name: input.name,
			headSha: input.headSha,
			status: 'in_progress',
			detailsUrl: input.detailsUrl,
			...input.output,
			outputs: input.output ? [input.output] : []
		});
		return id;
	}

	async updateCheckRun(checkRunId: number, output: { title: string; summary: string }) {
		const run = this.checkRun(checkRunId);
		Object.assign(run, output);
		run.outputs.push(output);
	}

	async completeCheckRun(
		checkRunId: number,
		input: { conclusion: CheckConclusion; title: string; summary: string }
	): Promise<void> {
		const run = this.checkRun(checkRunId);
		Object.assign(run, input, { status: 'completed' });
		run.outputs.push({ title: input.title, summary: input.summary });
	}

	private checkRun(id: number): MemoryCheckRun {
		const run = this.checkRuns.find((r) => r.id === id);
		if (!run) throw new Error(`check run ${id} not found`);
		return run;
	}

	private urlOf(commentId: number): string {
		return `https://github.test/pull/${this.pullRequest.number}#issuecomment-${commentId}`;
	}
}

/** Answers one command in a `MemorySandboxes` sandbox. */
export type CommandHandler = (command: string) => SandboxResult | Promise<SandboxResult>;

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
