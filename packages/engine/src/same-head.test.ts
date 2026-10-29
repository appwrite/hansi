import { expect, test } from 'bun:test';
import type { ReviewRecord } from './results';
import {
	mentionWantsSameHeadReply,
	otherPullReviews,
	sameHeadCoalesce,
	sameHeadSkipSummary,
	type SameHeadReview
} from './same-head';

const head = 'ff08776ef21c7c71d0e70879e7a9d4eaec748faf';
const newer = '8c9e11011094efa588f6d7a1f033328df470325c';

function review(status: SameHeadReview['status'], headSha = head): SameHeadReview {
	return { status, headSha };
}

test('a completed review of this commit skips the follow-up', () => {
	expect(sameHeadCoalesce(head, [review('completed')], 'synchronize')).toBe('already-reviewed');
});

test('an explicit review request re-reviews a commit that is already reviewed', () => {
	expect(sameHeadCoalesce(head, [review('completed')], 'mention')).toBeNull();
	expect(sameHeadCoalesce(head, [review('completed')], 'opened')).toBe('already-reviewed');
	expect(sameHeadCoalesce(head, [review('completed')], 'manual')).toBe('already-reviewed');
});

test('an explicit review request still waits for a running review of the same commit', () => {
	expect(sameHeadCoalesce(head, [review('processing'), review('completed')], 'mention')).toBe(
		'in-flight'
	);
});

test('a running review of this commit skips the follow-up', () => {
	expect(sameHeadCoalesce(head, [review('processing')], 'synchronize')).toBe('in-flight');
});

test('a completed review wins over one that is still running', () => {
	expect(sameHeadCoalesce(head, [review('processing'), review('completed')], 'synchronize')).toBe(
		'already-reviewed'
	);
});

test('failed, skipped, superseded, and queued attempts still leave the commit to review', () => {
	for (const status of ['failed', 'skipped', 'superseded', 'queued'] as const) {
		expect(sameHeadCoalesce(head, [review(status)], 'synchronize')).toBeNull();
	}
});

test('a new commit is reviewed even when the previous one finished', () => {
	expect(
		sameHeadCoalesce(newer, [review('completed', head), review('processing', head)], 'synchronize')
	).toBeNull();
});

test('an unresolved head is not treated as already reviewed', () => {
	expect(sameHeadCoalesce('', [review('completed', '')], 'synchronize')).toBeNull();
});

test('the skip summary names the short commit', () => {
	expect(sameHeadSkipSummary('already-reviewed', head)).toBe(
		"Already reviewed ff08776. No new commits since then, so I didn't post another review."
	);
	expect(sameHeadSkipSummary('in-flight', head)).toBe(
		"A review of ff08776 is already running, so I didn't start another one."
	);
});

test('only a mention gets a reply when the commit is already covered', () => {
	expect(mentionWantsSameHeadReply('mention')).toBe(true);
	for (const trigger of ['opened', 'synchronize', 'manual']) {
		expect(mentionWantsSameHeadReply(trigger)).toBe(false);
	}
});

test('the lookup leaves out the review itself', () => {
	const row = (id: string, headSha: string, status: ReviewRecord['status']): ReviewRecord => ({
		id,
		status,
		trigger: 'opened',
		headSha,
		summary: '',
		tierReason: '',
		walkthrough: []
	});
	const others = otherPullReviews(
		[
			row('self', head, 'processing'),
			row('done', head, 'completed'),
			row('busy', newer, 'processing')
		],
		'self'
	);
	expect(others).toEqual([
		{ headSha: head, status: 'completed' },
		{ headSha: newer, status: 'processing' }
	]);
	expect(sameHeadCoalesce(head, others, 'synchronize')).toBe('already-reviewed');
	expect(sameHeadCoalesce(newer, others, 'synchronize')).toBe('in-flight');
});
