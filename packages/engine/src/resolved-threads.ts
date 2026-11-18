import type { Log } from './context';
import type { GitHubConnection, ReviewThread } from './github';
import type { FindingReactions, FindingRecord, PullRef, ResultsSink } from './results';

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
 * Findings whose comment's reactions differ from what was stored, with the counts read now.
 * Only threads whose client read reactions count, so a provider without them writes nothing.
 */
export function reactionChanges(
	findings: readonly Pick<FindingRecord, 'id' | 'providerCommentId' | 'upvotes' | 'downvotes'>[],
	threads: readonly ReviewThread[]
): ({ id: string } & FindingReactions)[] {
	const byRoot = new Map(
		threads.flatMap((t) =>
			t.rootCommentId && t.reactions ? [[t.rootCommentId, t.reactions] as const] : []
		)
	);
	return findings.flatMap((f) => {
		const reactions = f.providerCommentId ? byRoot.get(f.providerCommentId) : undefined;
		if (!reactions) return [];
		if (reactions.upvotes === (f.upvotes ?? 0) && reactions.downvotes === (f.downvotes ?? 0)) {
			return [];
		}
		return [{ id: f.id, upvotes: reactions.upvotes, downvotes: reactions.downvotes }];
	});
}

/**
 * Brings the pull request's findings in step with their threads on GitHub: dismisses open
 * findings whose thread someone with write access resolved, and stores the 👍 and 👎 on every
 * posted finding's comment, settled ones included, since people react after the fact too.
 *
 * Resolving the thread is how a maintainer closes a discussion. Without this, the next review
 * still saw the finding as open, checked whether the code "fixed" it, and kept it open, so the
 * grade, the summary, and the verdict ignored the decision. Dismissed findings are also not
 * reported again. Returns how many findings it dismissed.
 */
export async function syncFindingsWithThreads(
	results: ResultsSink,
	{ github, app }: GitHubConnection,
	pull: PullRef,
	findings: readonly FindingRecord[],
	log: Log
): Promise<number> {
	const posted = findings.filter((f) => f.status !== 'dropped' && f.providerCommentId !== null);
	if (posted.length === 0) return 0;

	let threads: ReviewThread[];
	try {
		threads = await github.listReviewThreads(pull.pullNumber);
	} catch (error) {
		log.warn('could not read review threads', { err: error });
		return 0;
	}

	await storeReactions(results, pull, posted, threads, log);

	const open = posted.filter((f) => f.status === 'posted');
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
			from: 'posted',
			settlement: 'thread'
		});
		dismissed++;
	}
	if (dismissed) log.info('dismissed findings whose thread was resolved on GitHub', { dismissed });
	return dismissed;
}

/**
 * Stores the 👍 and 👎 on the pull request's posted findings, e.g. after answering in a thread,
 * where people react too. Never throws: reactions are a signal for the Console, not for the job.
 */
export async function recordFindingReactions(
	results: ResultsSink,
	github: GitHubConnection['github'],
	pull: PullRef,
	findings: readonly FindingRecord[],
	log: Log
): Promise<void> {
	const posted = findings.filter((f) => f.status !== 'dropped' && f.providerCommentId !== null);
	if (posted.length === 0) return;
	try {
		await storeReactions(
			results,
			pull,
			posted,
			await github.listReviewThreads(pull.pullNumber),
			log
		);
	} catch (error) {
		log.warn('could not read review threads', { err: error });
	}
}

async function storeReactions(
	results: ResultsSink,
	pull: PullRef,
	findings: readonly FindingRecord[],
	threads: readonly ReviewThread[],
	log: Log
): Promise<void> {
	const reactions = reactionChanges(findings, threads);
	if (reactions.length === 0) return;
	await results
		.updateReactions(pull, reactions)
		.catch((error: unknown) => log.warn('could not store finding reactions', { err: error }));
}
