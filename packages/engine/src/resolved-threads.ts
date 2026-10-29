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
	findings: { id: string; githubCommentId: number }[],
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
		const resolvedBy = byRoot.get(f.githubCommentId);
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
		open.map((f) => ({ id: f.id, githubCommentId: f.providerCommentId! })),
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
