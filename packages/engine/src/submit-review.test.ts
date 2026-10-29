import { describe, expect, test } from 'bun:test';
import {
	shouldDismissChangeRequest,
	shouldSubmitReview,
	submissionForCurrentHead
} from './submit-review';

const quiet = {
	posted: 0,
	verdict: 'comment' as const,
	tier: 'S' as const,
	previousTier: 'A' as const,
	lastDecisiveVerdict: null,
	trigger: 'synchronize'
};

test('reaching Tier S leaves a review even when approval stays a comment', () => {
	expect(shouldSubmitReview(quiet)).toBe(true);
});

test('the first clean review leaves a review', () => {
	expect(shouldSubmitReview({ ...quiet, previousTier: undefined })).toBe(true);
});

test('a later Tier S review with nothing new stays in the summary', () => {
	expect(shouldSubmitReview({ ...quiet, previousTier: 'S' })).toBe(false);
});

test('inline comments, a new approval, and a mention still submit', () => {
	expect(shouldSubmitReview({ ...quiet, previousTier: 'S', posted: 1, tier: 'A' })).toBe(true);
	expect(
		shouldSubmitReview({
			...quiet,
			previousTier: 'S',
			verdict: 'approve',
			lastDecisiveVerdict: null
		})
	).toBe(true);
	expect(
		shouldSubmitReview({
			...quiet,
			previousTier: 'S',
			verdict: 'approve',
			lastDecisiveVerdict: 'approve'
		})
	).toBe(false);
	expect(shouldSubmitReview({ ...quiet, previousTier: 'S', trigger: 'mention' })).toBe(true);
});

const reviewed = '410aa75000000000000000000000000000000000';
const current = '8c9e110000000000000000000000000000000000';

test('an unchanged head keeps the verdict and the submit decision', () => {
	expect(
		submissionForCurrentHead({
			reviewedSha: reviewed,
			currentHeadSha: reviewed.toUpperCase(),
			verdict: 'approve',
			posted: 0,
			shouldSubmit: true
		})
	).toEqual({ headMoved: false, verdict: 'approve', submit: true, note: null });
	expect(
		submissionForCurrentHead({
			reviewedSha: reviewed,
			currentHeadSha: reviewed,
			verdict: 'approve',
			posted: 0,
			shouldSubmit: false
		})
	).toEqual({ headMoved: false, verdict: 'approve', submit: false, note: null });
});

test('a moved head does not approve, and skips a review that only approved', () => {
	const decision = submissionForCurrentHead({
		reviewedSha: reviewed,
		currentHeadSha: current,
		verdict: 'approve',
		posted: 0,
		shouldSubmit: true
	});
	expect(decision.headMoved).toBe(true);
	expect(decision.verdict).toBe('comment');
	expect(decision.submit).toBe(false);
	expect(decision.note).toContain('Newer commits exist (`8c9e110`) and will be reviewed');
	expect(decision.note).toContain('This review is of `410aa75` and does not approve it');
});

test('a moved head still posts inline comments, as a comment review', () => {
	expect(
		submissionForCurrentHead({
			reviewedSha: reviewed,
			currentHeadSha: current,
			verdict: 'approve',
			posted: 2,
			shouldSubmit: true
		})
	).toMatchObject({ headMoved: true, verdict: 'comment', submit: true });
	expect(
		submissionForCurrentHead({
			reviewedSha: reviewed,
			currentHeadSha: current,
			verdict: 'request_changes',
			posted: 1,
			shouldSubmit: true
		})
	).toMatchObject({ headMoved: true, verdict: 'comment', submit: true });
});

test('a moved head with nothing to comment does not leave a review', () => {
	expect(
		submissionForCurrentHead({
			reviewedSha: reviewed,
			currentHeadSha: current,
			verdict: 'comment',
			posted: 0,
			shouldSubmit: true
		})
	).toMatchObject({ headMoved: true, verdict: 'comment', submit: false });
});

describe('shouldDismissChangeRequest', () => {
	const fixed = {
		verdict: 'comment' as const,
		blockingOpen: 0,
		lastDecisiveVerdict: 'request_changes' as const,
		headMoved: false
	};

	test('withdraws a change request once nothing blocking is open', () => {
		expect(shouldDismissChangeRequest(fixed)).toBe(true);
	});

	test('keeps it while a blocking finding is still open', () => {
		expect(shouldDismissChangeRequest({ ...fixed, blockingOpen: 1 })).toBe(false);
	});

	test('leaves an approval or a new change request to replace it', () => {
		expect(shouldDismissChangeRequest({ ...fixed, verdict: 'approve' })).toBe(false);
		expect(shouldDismissChangeRequest({ ...fixed, verdict: 'request_changes' })).toBe(false);
	});

	test('does nothing without an earlier change request or when the head moved', () => {
		expect(shouldDismissChangeRequest({ ...fixed, lastDecisiveVerdict: 'approve' })).toBe(false);
		expect(shouldDismissChangeRequest({ ...fixed, lastDecisiveVerdict: null })).toBe(false);
		expect(shouldDismissChangeRequest({ ...fixed, headMoved: true })).toBe(false);
	});
});
