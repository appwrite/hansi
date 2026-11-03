import type { Tier, Verdict } from './config';
import type { SummaryInput } from './format';
import type { PullRequestDelta } from './git';
import { finalTier, standingFromOpenFindings } from './tier';
import { severityAtLeast, type Severity } from './config';
import { summaryAfterSettlement, type SummaryExtras } from './summary';

const verdicts = ['approve', 'request_changes', 'comment'] as const satisfies readonly Verdict[];
const tiers = ['S', 'A', 'B', 'C', 'D', 'F'] as const satisfies readonly Tier[];

/** The previous completed review, which a merge-only push keeps as-is. */
export interface CarriedReview {
	id: string;
	headSha: string;
	summary: string;
	verdict: Verdict;
	tier: Tier;
	tierReason: string;
	walkthrough: { path: string; change: string }[];
}

export function carriedReview(input: {
	id?: string;
	headSha?: string;
	summary?: string | null;
	verdict?: string | null;
	tier?: string | null;
	tierReason?: string | null;
	walkthrough?: { path: string; change: string }[] | null;
}): CarriedReview | null {
	if (!input.id || !input.headSha || !input.summary) return null;
	if (!isOneOf(input.verdict, verdicts) || !isOneOf(input.tier, tiers)) return null;
	return {
		id: input.id,
		headSha: input.headSha,
		summary: input.summary,
		verdict: input.verdict,
		tier: input.tier,
		tierReason: input.tierReason ?? '',
		walkthrough: input.walkthrough ?? []
	};
}

function isOneOf<T extends string>(
	value: string | null | undefined,
	allowed: readonly T[]
): value is T {
	return !!value && (allowed as readonly string[]).includes(value);
}

/**
 * The carried grade and verdict after findings settled since that review, e.g. a maintainer
 * resolved a thread. The model grades below S only for a finding, so with nothing open the pull
 * request is at S, as a full review would grade it. A grade that only an open finding held down
 * follows the findings that are still open; otherwise the model's own grade is kept, but never
 * better than they allow. A change request stands only while a blocking finding is open; after
 * that the verdict becomes a comment, so the check run no longer fails on settled findings.
 * `blocking` is null when the repository never requests changes: no change request stands.
 */
export function settledCarriedReview(
	review: CarriedReview,
	open: { severity: Severity; title: string }[],
	blocking: Severity | null
): CarriedReview {
	const verdict =
		review.verdict === 'request_changes' &&
		!open.some((f) => blocking !== null && severityAtLeast(f.severity, blocking))
			? 'comment'
			: review.verdict;
	const standing = standingFromOpenFindings(open);
	if (open.length === 0) {
		return {
			...review,
			verdict,
			tier: 'S',
			tierReason: review.tier === 'S' ? review.tierReason : ''
		};
	}
	if (review.tierReason.startsWith(CAPPED_REASON)) return { ...review, verdict, ...standing };
	const tier = finalTier(review.tier, standing.tier);
	return tier === review.tier
		? { ...review, verdict }
		: { ...review, verdict, tier, tierReason: standing.tierReason };
}

/** How `standingFromOpenFindings` starts a reason: the grade came from a finding, not the model. */
const CAPPED_REASON = 'Limited by an open ';

/** Footer sentence for a push that merged the base branch and did not change the pull request. */
export function mergeOnlyScopeLine(input: {
	baseRef: string;
	mergedSha: string;
	sinceSha: string;
}): string {
	const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
	return `Merged ${code(input.baseRef)} (${code(input.mergedSha.slice(0, 7))}); no changes to this PR's code since ${code(input.sinceSha.slice(0, 7))}`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type IncrementalDecision =
	| { kind: 'full' }
	| { kind: 'incremental'; diff: string }
	| {
			kind: 'merge-only';
			scope: string;
			/** A merge-only push edits the summary comment and does not open a new GitHub review. */
			submitReview: false;
			baseRef: string;
			mergedSha: string;
			sinceSha: string;
			review: CarriedReview;
	  };

/**
 * What to do with an incremental push. An unchanged pull-request delta keeps the previous
 * result. A missing previous result, or a delta git could not compute, reviews the whole PR.
 */
export function decideIncrementalReview(input: {
	delta: PullRequestDelta;
	baseRef: string;
	mergedSha: string;
	sinceSha: string;
	previous: CarriedReview | null;
}): IncrementalDecision {
	if (input.delta.status === 'changed') return { kind: 'incremental', diff: input.delta.diff };
	if (input.delta.status !== 'unchanged' || !input.previous) return { kind: 'full' };
	return {
		kind: 'merge-only',
		scope: mergeOnlyScopeLine(input),
		submitReview: false,
		baseRef: input.baseRef,
		mergedSha: input.mergedSha,
		sinceSha: input.sinceSha,
		review: input.previous
	};
}

/** Summary comment for a merge-only push: the previous review, with only the footer rewritten. */
export function carriedSummaryInput(input: {
	repository: string;
	mention: string;
	detailsUrl?: string;
	scope: string;
	review: CarriedReview;
	findings: Parameters<typeof summaryAfterSettlement>[0]['findings'];
	extras: SummaryExtras;
}): SummaryInput {
	const built = summaryAfterSettlement({
		repository: input.repository,
		headSha: input.review.headSha,
		summary: input.review.summary,
		verdict: input.review.verdict,
		walkthrough: input.review.walkthrough,
		latestReviewId: input.review.id,
		findings: input.findings,
		detailsUrl: input.detailsUrl,
		mention: input.mention,
		...input.extras,
		scope: input.scope
	});
	return {
		...built,
		tier: input.review.tier,
		tierReason: input.review.tierReason,
		scope: input.scope
	};
}
