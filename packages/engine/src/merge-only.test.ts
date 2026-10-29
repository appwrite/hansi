import { describe, expect, test } from 'bun:test';
import { formatSummaryComment } from './format';
import {
	carriedReview,
	carriedSummaryInput,
	decideIncrementalReview,
	settledCarriedReview,
	type CarriedReview
} from './merge-only';
import { summaryExtrasFromBody } from './summary';

const previous: CarriedReview = {
	id: 'review-1',
	headSha: '19db7f0abcdef1234567890abcdef1234567890',
	summary: 'Stops redelivering function events.',
	verdict: 'approve',
	tier: 'S',
	tierReason: '',
	walkthrough: [{ path: 'src/functions.ts', change: 'Skips duplicate deliveries.' }]
};

const merged = '72e96c6abcdef1234567890abcdef1234567890';

describe('decideIncrementalReview', () => {
	test('an unchanged delta keeps the previous result and does not submit a review', () => {
		const decision = decideIncrementalReview({
			delta: { status: 'unchanged' },
			baseRef: 'main',
			mergedSha: merged,
			sinceSha: previous.headSha,
			previous
		});
		expect(decision.kind).toBe('merge-only');
		if (decision.kind !== 'merge-only') return;
		expect(decision.submitReview).toBe(false);
		expect(decision.review.verdict).toBe('approve');
		expect(decision.review.tier).toBe('S');
		expect(decision.review.summary).toBe(previous.summary);
		expect(decision.review.walkthrough).toEqual(previous.walkthrough);
		expect(decision.scope).toBe(
			"Merged <code>main</code> (<code>72e96c6</code>); no changes to this PR's code since <code>19db7f0</code>"
		);
	});

	test('a changed delta is still reviewed incrementally', () => {
		const diff = 'diff --git a/src/functions.ts b/src/functions.ts\n';
		expect(
			decideIncrementalReview({
				delta: { status: 'changed', diff },
				baseRef: 'main',
				mergedSha: merged,
				sinceSha: previous.headSha,
				previous
			})
		).toEqual({ kind: 'incremental', diff });
	});

	test('a force-push fallback reviews the whole pull request', () => {
		expect(
			decideIncrementalReview({
				delta: { status: 'fallback' },
				baseRef: 'main',
				mergedSha: merged,
				sinceSha: previous.headSha,
				previous
			})
		).toEqual({ kind: 'full' });
	});

	test('an unchanged delta without a previous result reviews the whole pull request', () => {
		expect(
			decideIncrementalReview({
				delta: { status: 'unchanged' },
				baseRef: 'main',
				mergedSha: merged,
				sinceSha: previous.headSha,
				previous: null
			})
		).toEqual({ kind: 'full' });
		expect(
			carriedReview({
				id: 'review-1',
				headSha: previous.headSha,
				summary: previous.summary,
				verdict: null,
				tier: 'S'
			})
		).toBeNull();
	});
});

describe('carried summary', () => {
	test('rewrites only the scope line and keeps the previous grade, verdict, and walkthrough', () => {
		const decision = decideIncrementalReview({
			delta: { status: 'unchanged' },
			baseRef: 'main',
			mergedSha: merged,
			sinceSha: previous.headSha,
			previous
		});
		if (decision.kind !== 'merge-only') throw new Error('expected the merge-only path');

		const input = carriedSummaryInput({
			repository: 'acme/api',
			mention: '@hansi-codes',
			detailsUrl: 'https://hans.example/app/acme/reviews/review-2',
			scope: decision.scope,
			review: decision.review,
			findings: [
				{
					reviewId: 'review-1',
					path: 'src/functions.ts',
					startLine: 4,
					endLine: 4,
					severity: 'major',
					category: 'bug',
					title: 'Off by one',
					body: 'The first event is skipped.',
					suggestion: null,
					status: 'posted',
					dropReason: null
				}
			],
			extras: { latestChanges: 'Skips duplicate deliveries.', approvalWithheld: null }
		});
		expect(input.tier).toBe('S');
		expect(input.tierReason).toBe('');
		expect(input.verdict).toBe('approve');
		expect(input.walkthrough).toEqual(previous.walkthrough);
		expect(input.posted.map((finding) => finding.title)).toEqual(['Off by one']);

		const body = formatSummaryComment(input);
		// The carried grade stays, including when posted findings would grade the PR lower.
		expect(body).toContain('## 🟢 Tier S');
		expect(body).not.toContain('Tier B');
		expect(body).toContain('| ✅ Approved | 1 | 0 | 0 |');
		expect(body).toContain('Stops redelivering function events.');
		expect(body).toContain('**Latest changes:** Skips duplicate deliveries.');
		expect(body).toContain('| `src/functions.ts` | Skips duplicate deliveries. |');
		expect(body).toContain(decision.scope);
		expect(body).not.toContain('Reviewed the commits since');
		expect(body).not.toContain('Reviewed <code>');

		expect(summaryExtrasFromBody(body).scope).toBe(decision.scope);
		const rebuilt = formatSummaryComment(
			carriedSummaryInput({
				repository: 'acme/api',
				mention: '@hansi-codes',
				scope: summaryExtrasFromBody(body).scope ?? decision.scope,
				review: decision.review,
				findings: [],
				extras: summaryExtrasFromBody(body)
			})
		);
		expect(rebuilt).toContain(decision.scope);
	});
});

describe('settledCarriedReview', () => {
	const review = {
		id: 'r1',
		headSha: 'abc1234',
		summary: 'Adds a sandbox.',
		verdict: 'comment' as const,
		walkthrough: []
	};

	test('a grade held down by a finding that was since resolved follows what is open', () => {
		const capped = {
			...review,
			tier: 'D' as const,
			tierReason: 'Limited by an open critical finding: X'
		};
		expect(settledCarriedReview(capped, [])).toMatchObject({ tier: 'S', tierReason: '' });
		expect(settledCarriedReview(capped, [{ severity: 'minor', title: 'Y' }])).toMatchObject({
			tier: 'A',
			tierReason: 'Limited by an open minor finding: Y'
		});
	});

	test("the model's own grade stays, but never better than open findings allow", () => {
		const graded = { ...review, tier: 'B' as const, tierReason: 'Untested edge cases.' };
		expect(settledCarriedReview(graded, [])).toBe(graded);
		expect(settledCarriedReview(graded, [{ severity: 'critical', title: 'Z' }])).toMatchObject({
			tier: 'D',
			tierReason: 'Limited by an open critical finding: Z'
		});
	});
});
