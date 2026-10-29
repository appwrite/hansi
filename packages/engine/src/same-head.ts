import type { ReviewRecord, ReviewStatus } from './results';

export interface SameHeadReview {
	headSha: string;
	status: ReviewStatus;
}

/** Why a follow-up trigger should not review this commit again. */
export type SameHeadCoalesce = 'in-flight' | 'already-reviewed';

/**
 * Whether a trigger for `headSha` should be skipped because this pull request already has a
 * review of that commit.
 *
 * A completed review already posted its result. A processing one will. Failed, skipped, and
 * superseded attempts do not count: the commit still needs a review. A queued sibling does not
 * count either. This caller holds the queue lock, and that row has not started. A different
 * commit never matches.
 *
 * An explicit `@slug review` always reviews again, even a commit that is already reviewed:
 * someone asked on purpose. It still waits out a review of the same commit that is running,
 * since that one is about to post.
 */
export function sameHeadCoalesce(
	headSha: string,
	others: readonly SameHeadReview[],
	trigger: string
): SameHeadCoalesce | null {
	if (!headSha) return null;
	const same = others.filter((review) => review.headSha === headSha);
	const asked = trigger === 'mention';
	if (!asked && same.some((review) => review.status === 'completed')) return 'already-reviewed';
	if (same.some((review) => review.status === 'processing')) return 'in-flight';
	return null;
}

/** Shown on the skipped review, and posted when the trigger was a mention. */
export function sameHeadSkipSummary(reason: SameHeadCoalesce, headSha: string): string {
	const short = headSha.slice(0, 7);
	if (reason === 'in-flight') {
		return `A review of ${short} is already running, so I didn't start another one.`;
	}
	return `Already reviewed ${short}. No new commits since then, so I didn't post another review.`;
}

/** A mention is a person waiting on a reply. A push of the same commit is dropped quietly. */
export function mentionWantsSameHeadReply(trigger: string): boolean {
	return trigger === 'mention';
}

/** Other reviews of this pull request, including ones for older commits. */
export function otherPullReviews(
	reviews: readonly ReviewRecord[],
	reviewId: string
): SameHeadReview[] {
	return reviews
		.filter((review) => review.id !== reviewId)
		.map((review) => ({ headSha: review.headSha, status: review.status }));
}
