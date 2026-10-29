import type { Log } from './context';
import type { ReviewJob } from './jobs';

/**
 * Why a review stopped before the model ran, in the cases a person who asked for it
 * should hear about.
 */
export const mentionSkipReasons = ['merged', 'closed', 'disabled', 'draft', 'base-branch'] as const;
export type MentionSkipReason = (typeof mentionSkipReasons)[number];

/** A push or a dashboard retry is dropped quietly. A mention is someone waiting. */
export function mentionWantsSkipReply(trigger: string): boolean {
	return trigger === 'mention';
}

/**
 * The one-line reply for a skipped mention, or null when this trigger stays quiet.
 * The text never contains an `@mention`, so posting it cannot start another review.
 */
export function mentionSkipReply(
	trigger: string,
	reason: MentionSkipReason,
	detail?: { baseRef?: string }
): string | null {
	if (!mentionWantsSkipReply(trigger)) return null;
	switch (reason) {
		case 'merged':
			return "This pull request is merged, so Hansi doesn't review it anymore.";
		case 'closed':
			return "This pull request is closed, so Hansi doesn't review it anymore.";
		case 'disabled':
			return "Reviews are disabled for this repository, so Hansi doesn't review it.";
		case 'draft':
			return "This pull request is a draft, so Hansi doesn't review it yet.";
		case 'base-branch':
			return baseBranchReply(detail?.baseRef);
	}
}

function baseBranchReply(baseRef: string | undefined): string {
	const branch = baseRef?.trim() ?? '';
	// A branch name is untrusted. Echoing `@slug` would enqueue another review.
	if (!branch || branch.includes('@') || /[\r\n]/.test(branch)) {
		return "This pull request's base branch isn't one Hansi reviews.";
	}
	return `This pull request targets ${branch}, which Hansi doesn't review.`;
}

/** Closed and merged pull requests are not reviewed. Open ones are. */
export function closedPullRequestSkip(pr: {
	state: string;
	merged: boolean;
}): 'merged' | 'closed' | null {
	if (pr.state === 'open') return null;
	return pr.merged ? 'merged' : 'closed';
}

export type ConfiguredSkip = 'disabled' | 'automatic-disabled' | 'draft' | 'base-branch';

export interface ConfiguredSkipInput {
	trigger: string;
	enabled: boolean;
	auto: boolean;
	draft: boolean;
	reviewDrafts: boolean;
	baseBranches: readonly string[];
	baseRef: string;
}

/**
 * Filters from `.hansi.json`. A mention bypasses the automatic-only ones (auto off, drafts,
 * base branches): asking is how you review those on purpose. Disabling reviews stops everyone.
 */
export function configuredReviewSkip(input: ConfiguredSkipInput): ConfiguredSkip | null {
	const automatic = input.trigger === 'opened' || input.trigger === 'synchronize';
	if (!input.enabled) return 'disabled';
	if (!automatic) return null;
	if (!input.auto) return 'automatic-disabled';
	if (input.draft && !input.reviewDrafts) return 'draft';
	if (input.baseBranches.length > 0 && !input.baseBranches.includes(input.baseRef)) {
		return 'base-branch';
	}
	return null;
}

/** The sentence stored on the review when nobody is waiting on a reply. */
export function configuredSkipSummary(reason: ConfiguredSkip, baseRef: string): string {
	switch (reason) {
		case 'disabled':
			return 'Reviews are disabled in .hansi.json';
		case 'automatic-disabled':
			return 'Automatic reviews are disabled in .hansi.json';
		case 'draft':
			return 'Draft pull request';
		case 'base-branch':
			return `Base branch ${baseRef} is not configured for reviews`;
	}
}

/** The comment to react on, when this job was started by a mention. */
export function reviewMentionComment(
	job: Pick<ReviewJob, 'trigger'>
): { id: number; kind: 'issue' | 'review' } | null {
	return job.trigger.kind === 'mention' ? job.trigger.comment : null;
}

/**
 * Reacts with 👀. A failure is logged and swallowed: the review must still run, and a skip
 * reply must still be posted.
 */
export async function acknowledgeReviewMention(
	react: () => Promise<unknown>,
	log: Log
): Promise<void> {
	await react().catch((error: unknown) => log.warn('could not react to comment', { err: error }));
}

/**
 * Posts the one-line explanation on the pull request. A failure is logged and swallowed so a
 * skip is still recorded.
 */
export async function postMentionReply(
	post: (body: string) => Promise<unknown>,
	body: string,
	log: Log,
	failure: string
): Promise<void> {
	await post(body).catch((error: unknown) => log.warn(failure, { err: error }));
}
