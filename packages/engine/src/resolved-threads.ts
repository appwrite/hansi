import type { Log } from './context';
import type { GitHubConnection, ReviewThread } from './github';
import type { FindingRecord, PullRef, ResultsSink } from './results';

/**
 * Open findings whose GitHub thread a person resolved, with who resolved it.
 *
 * Hansi resolves threads it fixed itself, and those findings are already marked resolved, so a
 * resolution by the bot is ignored here. Write access is checked by the caller.
 */
export function threadsResolvedByPeople(
	findings: { id: string; providerCommentId: string }[],
	threads: ReviewThread[],
	botLogin: string
): { findingId: string; resolvedBy: string }[] {
	const bot = botLogin.toLowerCase();
	const byRoot = new Map(
		threads
			.filter((t) => t.isResolved && t.resolvedBy && t.resolvedBy.toLowerCase() !== bot)
			.map((t) => [t.rootCommentId, t.resolvedBy!] as const)
	);
	return findings.flatMap((f) => {
		const resolvedBy = byRoot.get(f.providerCommentId);
		return resolvedBy ? [{ findingId: f.id, resolvedBy }] : [];
	});
}

/**
 * Dismisses open findings whose thread someone with write access resolved on GitHub.
 *
 * Resolving the thread is how a maintainer closes a discussion. Without this, the next review
 * still saw the finding as open, checked whether the code "fixed" it, and kept it open, so the
 * grade, the summary, and the verdict ignored the decision. Dismissed findings are also not
 * reported again. Returns how many findings it dismissed.
 */
export async function dismissFindingsResolvedOnGitHub(
	results: ResultsSink,
	{ github, app }: GitHubConnection,
	pull: PullRef,
	findings: readonly FindingRecord[],
	log: Log
): Promise<number> {
	const open = findings.filter((f) => f.status === 'posted' && f.providerCommentId !== null);
	if (open.length === 0) return 0;

	let threads: ReviewThread[];
	try {
		threads = await github.listReviewThreads(pull.pullNumber);
	} catch (error) {
		log.warn('could not read review threads', { err: error });
		return 0;
	}
	const candidates = threadsResolvedByPeople(
		open.map((f) => ({ id: f.id, providerCommentId: f.providerCommentId! })),
		threads,
		`${app.slug}[bot]`
	);

	// Anyone who can comment may be able to resolve a thread, including the PR author. Only a
	// person who can write to the repository settles a finding this way.
	const writers = new Map<string, boolean>();
	let dismissed = 0;
	for (const { findingId, resolvedBy } of candidates) {
		if (!writers.has(resolvedBy)) {
			writers.set(resolvedBy, await github.hasWriteAccess(resolvedBy));
		}
		if (!writers.get(resolvedBy)) continue;
		await results.updateFindings(pull, [findingId], {
			status: 'dismissed',
			reason: `Thread resolved on GitHub by @${resolvedBy}`,
			from: 'posted'
		});
		dismissed++;
	}
	if (dismissed) log.info('dismissed findings whose thread was resolved on GitHub', { dismissed });
	return dismissed;
}

/** Most replies read per finding: the latest ones, since the newest answer is what counts. */
const MAX_REPLIES = 5;
/** Most finding threads read per review. */
const MAX_THREADS = 20;
/** Most distinct reply authors whose write access one review checks. */
const MAX_AUTHORS = 20;

/**
 * Open findings with the replies people with write access left in their threads.
 *
 * A reply is normally answered by a chat job, which can dismiss the finding. When that job never
 * runs, for example because the comment was not delivered, a re-review otherwise checks only the
 * code and reports the finding again as if nobody had answered. With the replies in hand, the
 * review weighs them too.
 */
export async function withThreadReplies<F extends { providerCommentId?: string | null }>(
	{ github, app }: GitHubConnection,
	pull: PullRef,
	open: readonly F[],
	log: Log
): Promise<(F & { replies?: { author: string; body: string }[] })[]> {
	const bot = `${app.slug}[bot]`.toLowerCase();
	const writers = new Map<string, boolean>();
	const isWriter = async (login: string) => {
		if (!writers.has(login)) writers.set(login, await github.hasWriteAccess(login));
		return writers.get(login)!;
	};
	let read = 0;
	const out: (F & { replies?: { author: string; body: string }[] })[] = [];
	for (const finding of open) {
		if (!finding.providerCommentId || read >= MAX_THREADS) {
			out.push(finding);
			continue;
		}
		read++;
		try {
			const thread = await github.getReviewThread(pull.pullNumber, finding.providerCommentId);
			// Newest first, and only until enough are kept: each new author costs a permission check.
			const replies: { author: string; body: string }[] = [];
			for (const comment of thread.slice(1).reverse()) {
				if (replies.length >= MAX_REPLIES) break;
				if (comment.isBot || comment.author.toLowerCase() === bot) continue;
				if (!writers.has(comment.author) && writers.size >= MAX_AUTHORS) continue;
				if (!(await isWriter(comment.author))) continue;
				replies.unshift({ author: comment.author, body: comment.body });
			}
			out.push(replies.length ? { ...finding, replies } : finding);
		} catch (error) {
			log.warn('could not read a finding thread', { err: error });
			out.push(finding);
		}
	}
	return out;
}
