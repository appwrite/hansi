import { readFile } from 'node:fs/promises';
import type { LanguageModel } from 'ai';
import { runChat } from './chat';
import { changedFiles, checkout, readRepoConfig } from './checkout';
import type { EngineContext } from './context';
import type { GitHubClient, PullRequest } from './github';
import type { ChatJob } from './jobs';
import { REVIEW_MARKER, TRUSTED_ASSOCIATIONS } from './review-job';
import { resolveRepoPath } from './tools';

// One chat job, from the comment on GitHub to the reply under it. A comment that should not be
// answered ends the job quietly: the person asking sees no reply, the same as for any comment
// that does not mention the reviewer.

/** Earlier comments the prompt holds. */
const CONVERSATION_LIMIT = 20;
/** Lines shown on each side of the line a review thread is on. */
const THREAD_CONTEXT = 15;

export interface ChatJobOptions {
	model: LanguageModel;
	signal?: AbortSignal;
}

interface Asked {
	question: { id: number; author: string; body: string };
	conversation: { id: number; author: string; body: string }[];
	/** For a review thread: its first comment, which replies attach to, and where it is. */
	thread?: { rootId: number; path: string; line?: number };
}

export async function runChatJob(
	job: ChatJob,
	context: EngineContext,
	options: ChatJobOptions
): Promise<void> {
	const { comment } = job;
	// Not an app's comment: that keeps the reviewer from answering itself, or another bot, in a loop.
	if (comment.author.endsWith('[bot]')) return;
	const github = await context.github.forRepository(job.repository);
	const pr = await github.getPullRequest(job.pullNumber);
	// Every answer is a model run the project pays for: people with write access, and the author.
	const allowed =
		TRUSTED_ASSOCIATIONS.has(comment.authorAssociation) || comment.author === pr.author;
	if (!allowed) return;

	// The marker finds this answer again when a redelivery runs after it was posted.
	const marker = `<!-- hansi:chat ${comment.id} -->`;
	const asked = await findQuestion(github, job, pr, marker);
	if (!asked) return;

	const remote = await github.gitRemote();
	const tree = await checkout(
		remote,
		{ headSha: pr.head.sha, baseSha: pr.base.sha },
		options.signal
	);
	try {
		// Settings come from the base, like a review's.
		const { config } = await readRepoConfig(tree.dir, pr.base.sha, remote.token);
		if (!config.reviews.enabled) return;
		// Seen: an answer takes a while.
		await github.addReaction({ id: comment.id, kind: comment.kind }, 'eyes').catch(() => {});

		const files = await changedFiles(
			tree.dir,
			{ headSha: pr.head.sha, baseSha: pr.base.sha },
			{ token: remote.token, signal: options.signal }
		);
		const reply = await runChat(
			{
				repoDir: tree.dir,
				baseSha: pr.base.sha,
				token: remote.token,
				pullRequest: { title: pr.title, body: pr.body, author: pr.author },
				files,
				config,
				thread: asked.thread && {
					path: asked.thread.path,
					line: asked.thread.line,
					code: await codeAround(tree.dir, asked.thread.path, asked.thread.line)
				},
				conversation: asked.conversation,
				question: asked.question
			},
			{ model: options.model, signal: options.signal }
		);

		// Looked up again: an overlapping delivery of this job may have answered meanwhile.
		if (!(await findQuestion(github, job, pr, marker))) return;
		if (asked.thread) {
			await github.replyToReviewComment(pr.number, asked.thread.rootId, `${reply}\n\n${marker}`);
		} else {
			await github.createIssueComment(pr.number, `@${asked.question.author} ${reply}\n\n${marker}`);
		}
	} finally {
		await tree.remove();
	}
}

/** The comment to answer and what came before it, or null when it should not be answered. */
async function findQuestion(
	github: GitHubClient,
	job: ChatJob,
	pr: PullRequest,
	marker: string
): Promise<Asked | null> {
	const { comment } = job;
	if (comment.kind === 'issue') {
		const comments = await github.listIssueComments(pr.number);
		if (comments.some((c) => c.bot && c.body.includes(marker))) return null;
		const index = comments.findIndex((c) => c.id === comment.id);
		// Deleted since it was queued.
		if (index < 0) return null;
		return {
			question: comments[index]!,
			conversation: comments.slice(Math.max(0, index - CONVERSATION_LIMIT), index)
		};
	}

	const rootId = comment.rootCommentId ?? comment.id;
	const thread = (await github.listReviewComments(pr.number))
		.filter((c) => c.id === rootId || c.inReplyToId === rootId)
		.sort((a, b) => a.id - b.id);
	if (thread.some((c) => c.bot && c.body.includes(marker))) return null;
	const root = thread.find((c) => c.id === rootId);
	const index = thread.findIndex((c) => c.id === comment.id);
	if (!root || index < 0) return null;
	// A reply that does not mention the reviewer is for it only in a thread on its own finding.
	if (job.unmentioned) {
		const reviews = await github.listReviews(pr.number);
		const ours = reviews.some(
			(r) => r.bot && r.id === root.reviewId && r.body.includes(REVIEW_MARKER)
		);
		if (!root.bot || !ours) return null;
	}
	return {
		question: thread[index]!,
		conversation: thread.slice(Math.max(0, index - CONVERSATION_LIMIT), index),
		thread: { rootId, path: root.path, line: root.line }
	};
}

/** Numbered lines of the head version around `line`, or the start of the file without one. */
async function codeAround(repoDir: string, path: string, line?: number): Promise<string> {
	try {
		const lines = (await readFile(resolveRepoPath(repoDir, path), 'utf8')).split('\n');
		const first = Math.max((line ?? 1) - THREAD_CONTEXT, 1);
		const last = Math.min((line ?? 1) + THREAD_CONTEXT, lines.length);
		return lines
			.slice(first - 1, last)
			.map((text, i) => `${String(first + i).padStart(5)}  ${text}`)
			.join('\n');
	} catch {
		return '(not in the head of the pull request)';
	}
}
