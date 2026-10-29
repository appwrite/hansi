import type { Severity, Verdict } from './config';
import { compareSeverity, titleSimilarity } from './findings';
import { finalTier, standingFromOpenFindings, tiers, type Tier } from './tier';

/**
 * A finding the reader can see (posted, or still open from an earlier review) or one that was
 * filtered out. Only the title and body are used to tell whether the summary is talking about it.
 */
export interface PresentationFinding {
	severity: Severity;
	title: string;
	body?: string;
}

/**
 * The model writes the summary and the grade in the same call as its findings, before placement,
 * the severity filter, and the verifier can drop any of them. Reconcile both so a finding that
 * was not posted (filtered, or left unattached because it could not be placed) cannot set the
 * headline or pull the grade down.
 *
 * The grade is the cap from findings that will be shown. A worse grade from the model is kept
 * only when every finding was posted, because then it is a judgement about visible findings. When
 * something was not posted, that worse grade is not separable from the hidden findings, so it is
 * discarded. Rewriting the summary with another model call is unnecessary: a clause that copies
 * or paraphrases a dropped finding, or that passes judgement without matching a visible one, is
 * removed here.
 */
export function presentReview(input: {
	summary: string;
	modelTier: Tier | undefined;
	modelTierReason: string | undefined;
	verdict: Verdict;
	posted: PresentationFinding[];
	stillOpen: PresentationFinding[];
	dropped: PresentationFinding[];
}): { summary: string; tier: Tier; tierReason: string } {
	const grade = gradeVisibleFindings(input);
	return {
		...grade,
		summary: summaryWithoutDroppedFindings(input.summary, input.dropped, [
			...input.posted,
			...input.stillOpen
		])
	};
}

function gradeVisibleFindings(input: {
	modelTier: Tier | undefined;
	modelTierReason: string | undefined;
	verdict: Verdict;
	posted: PresentationFinding[];
	stillOpen: PresentationFinding[];
	dropped: PresentationFinding[];
}): { tier: Tier; tierReason: string } {
	const visible = [...input.posted, ...input.stillOpen].sort(compareSeverity);
	const hasDropped = input.dropped.length > 0;

	// An approval must not be labelled "needs changes". Soften before applying the cap, which
	// still holds an open major at B when majors are not blocking.
	let modelTier = input.modelTier;
	if (input.verdict === 'approve' && modelTier && tiers.indexOf(modelTier) > tiers.indexOf('A')) {
		modelTier = 'A';
	}

	if (visible.length === 0) {
		return {
			tier: 'S',
			tierReason: !hasDropped && input.modelTier === 'S' ? (input.modelTierReason ?? '') : ''
		};
	}

	const standing = standingFromOpenFindings(visible);
	// Anything not posted makes a worse model grade untrustworthy: it was chosen together with
	// findings the reader will not see. The reason is always the visible finding, never the
	// model's sentence, which may name a dropped one. Unattached findings are in `dropped` too.
	if (hasDropped) return standing;

	const tier = finalTier(modelTier, standing.tier);
	if (tier !== input.modelTier) return { tier, tierReason: standing.tierReason };
	return { tier, tierReason: input.modelTierReason ?? '' };
}

const SUMMARY_FALLBACK = 'Reviewed the changes in this pull request.';

/** A clause that is basically a dropped finding's title, even with no problem-language. */
const COPIED_FINDING = 0.5;
/** A clause that is about a finding the reader can already see. */
const VISIBLE_FINDING = 0.35;

/**
 * Judgement that does not describe the change. Dropped even with little overlap, because the
 * reported headlines paraphrase the finding instead of copying its title.
 */
const STRONG_JUDGEMENT =
	/\bneed(?:s)? (?:a )?fix(?:es|ing)?\b|\bbypass(?:es|ed|ing)?[\s-]+(?:write[\s-]+)?authori[sz]ation\b|\bauthori[sz]ation bypass\b/i;

/** Problem language. Counts only together with shared wording from a dropped finding. */
const PROBLEM_CUE =
	/\b(bypass(?:es|ed|ing)?|discard(?:s|ed|ing)?|leak(?:s|ed|ing)?|regression|rather than|instead of|fails? to|do(?:es)? not|doesn'?t|don'?t|missing|incorrect(?:ly)?|vulnerab(?:le|ility)|broken|silently)\b/i;

const STOPWORDS = new Set([
	'the',
	'and',
	'for',
	'with',
	'that',
	'this',
	'from',
	'into',
	'when',
	'than',
	'rather',
	'instead',
	'their',
	'them',
	'they',
	'are',
	'was',
	'were',
	'been',
	'being',
	'have',
	'has',
	'had',
	'not',
	'but',
	'its',
	'new',
	'also',
	'only',
	'after',
	'before',
	'over',
	'under',
	'does',
	'did',
	'can',
	'may',
	'will',
	'would',
	'should',
	'could',
	'about',
	'which',
	'while',
	'where',
	'what',
	'who',
	'how',
	'all',
	'any',
	'some',
	'such',
	'other',
	'more',
	'most',
	'very',
	'just',
	'still',
	'already',
	'because',
	'without',
	'even',
	'then',
	'out',
	'off',
	'per',
	'via',
	'onto',
	'upon',
	'between',
	'across',
	'during',
	'your',
	'our',
	'you',
	'there',
	'here',
	'these',
	'those',
	'each',
	'both',
	'once',
	'too'
]);

/**
 * Removes summary clauses that describe a filtered finding. A change description that merely
 * shares the finding's vocabulary is kept. When nothing was filtered, the summary is returned
 * unchanged. When every clause was about a filtered finding, a neutral sentence replaces it.
 */
export function summaryWithoutDroppedFindings(
	summary: string,
	dropped: PresentationFinding[],
	visible: PresentationFinding[]
): string {
	if (!summary.trim() || dropped.length === 0) return summary;
	const clauses = splitClauses(summary);
	if (clauses.length === 0) return summary;
	const kept = clauses.filter((clause) => !clauseCitesDropped(clause, dropped, visible));
	if (kept.length === clauses.length) return summary;
	const text = kept.map(asSentence).filter(Boolean).join(' ');
	return text || SUMMARY_FALLBACK;
}

function splitClauses(summary: string): string[] {
	const clauses: string[] = [];
	for (const block of summary.split(/\n+/)) {
		for (const sentence of block.split(/(?<=[.!?])\s+/)) {
			for (const clause of sentence.split(/,\s+and\s+|;\s+/i)) {
				const trimmed = clause.trim();
				if (trimmed) clauses.push(trimmed);
			}
		}
	}
	return clauses;
}

function asSentence(clause: string): string {
	const trimmed = clause.trim().replace(/[,;:]+$/, '');
	if (!trimmed) return '';
	const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function clauseCitesDropped(
	clause: string,
	dropped: PresentationFinding[],
	visible: PresentationFinding[]
): boolean {
	const shown = bestOverlap(clause, visible);
	const hidden = bestOverlap(clause, dropped);
	const aboutShown = shown.similarity >= VISIBLE_FINDING || shown.stems >= 2;
	if (hidden.similarity >= COPIED_FINDING && hidden.similarity > shown.similarity) return true;
	if (aboutShown) return false;
	if (STRONG_JUDGEMENT.test(clause)) return true;
	if (PROBLEM_CUE.test(clause) && (hidden.stems >= 2 || hidden.similarity >= VISIBLE_FINDING)) {
		return true;
	}
	return false;
}

function bestOverlap(clause: string, findings: PresentationFinding[]) {
	let similarity = 0;
	let stems = 0;
	for (const finding of findings) {
		for (const text of [finding.title, finding.body]) {
			if (!text?.trim()) continue;
			similarity = Math.max(similarity, titleSimilarity(clause, text));
			stems = Math.max(stems, sharedStemCount(clause, text));
		}
	}
	return { similarity, stems };
}

function sharedStemCount(a: string, b: string): number {
	const right = contentStems(b);
	const seen = new Set<string>();
	let count = 0;
	for (const stem of contentStems(a)) {
		if (seen.has(stem)) continue;
		seen.add(stem);
		if (right.some((other) => stemsMatch(stem, other))) count++;
	}
	return count;
}

function contentStems(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 3 && !STOPWORDS.has(word))
		.map(stemWord);
}

function stemWord(word: string): string {
	if (word === 'children') return 'child';
	let stripped = word;
	if (stripped.endsWith('ies') && stripped.length > 5) stripped = `${stripped.slice(0, -3)}y`;
	else if (stripped.endsWith('ing') && stripped.length > 6) stripped = stripped.slice(0, -3);
	else if (stripped.endsWith('ed') && stripped.length > 5) stripped = stripped.slice(0, -2);
	else if (stripped.endsWith('es') && stripped.length > 5) stripped = stripped.slice(0, -2);
	else if (stripped.endsWith('s') && stripped.length > 4) stripped = stripped.slice(0, -1);
	return stripped.length >= 3 ? stripped : word;
}

function stemsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return shorter.length >= 4 && longer.startsWith(shorter);
}
