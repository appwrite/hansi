import { severities, type Severity } from './config';
import { z } from 'zod';

export const categories = [
	'bug',
	'security',
	'performance',
	'concurrency',
	'error-handling',
	'maintainability',
	'testing',
	'documentation'
] as const;

/**
 * An optional field that also accepts null. Models often send null for "no value", and a strict
 * schema would throw away the whole submission over it.
 */
export function omittable<T extends z.ZodType>(schema: T) {
	return schema
		.nullable()
		.transform((value) => value ?? undefined)
		.optional();
}

export const findingSchema = z.object({
	path: z.string().describe('File path exactly as shown in the diff header'),
	startLine: z.number().int().positive().describe('First new-file line the finding refers to'),
	endLine: z
		.number()
		.int()
		.positive()
		.describe('Last new-file line; must be in the same diff hunk as startLine'),
	severity: z.enum(severities),
	category: z.enum(categories),
	title: z.string().describe('One-line summary, under 80 characters'),
	body: z
		.string()
		.describe('Why this is a problem and what happens at runtime. Markdown, no headings.'),
	suggestion: omittable(z.string()).describe(
		'Code only, never prose. GitHub replaces lines startLine..endLine verbatim with this text when the author clicks "Apply", so it must be the complete, correctly indented replacement for exactly those lines and keep the code compiling (every block it opens must close). No code fences, no comments explaining the fix. Omit unless the fix is small, local, and certain; explain larger fixes in the body instead.'
	)
});

export type Finding = z.infer<typeof findingSchema>;

export interface DroppedFinding extends Finding {
	dropReason: string;
}

/**
 * Why a finding could not be placed on a commentable line. The summary lists these under
 * "Couldn't attach to a line"; other drop reasons stay under "Filtered out".
 */
export const PLACEMENT_FAILURES = {
	outside_pr_diff: 'Lines outside the pull request diff',
	outside_hunk: 'Lines outside the changed hunks',
	not_in_diff: 'File not in this pull request',
	path_filtered: 'File excluded by path filters',
	no_commentable_lines: 'File has no commentable lines'
} as const;

export type PlacementFailureCode = keyof typeof PLACEMENT_FAILURES;

/**
 * Older reviews stored this single reason for every placement miss. Settlement still lists it
 * with the placement failures above.
 */
export const UNATTACHED_DROP_REASON = 'Not on a changed line';

const unattachedDropReasons = new Set<string>([
	...Object.values(PLACEMENT_FAILURES),
	UNATTACHED_DROP_REASON
]);

/** True when this drop is a placement miss, not a severity, duplicate, or verifier filter. */
export function isUnattachedDrop(reason: string): boolean {
	return unattachedDropReasons.has(reason);
}

export function compareSeverity(a: { severity: Severity }, b: { severity: Severity }) {
	return severities.indexOf(b.severity) - severities.indexOf(a.severity);
}

/** A finding posted by an earlier review of the same pull request. */
export interface PreviousFinding {
	path: string;
	startLine: number;
	endLine: number;
	category: string;
	title: string;
}

function words(text: string) {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 3)
	);
}

/** Jaccard similarity of the words in two titles. */
export function titleSimilarity(a: string, b: string): number {
	const left = words(a);
	const right = words(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared++;
	return shared / (left.size + right.size - shared);
}

/**
 * Whether a finding repeats one already posted on this pull request. Same file, lines that
 * overlap or sit a few lines apart (code shifts between pushes), and titles that describe the
 * same failure. Sharing the lines or the category is not enough: a different failure there
 * stays. When the titles do not clearly match, this returns false so both findings are kept.
 */
export function isDuplicateFinding(
	finding: Finding,
	previous: PreviousFinding[],
	lineTolerance = 3
): boolean {
	return previous.some((prior) => {
		if (prior.path !== finding.path) return false;
		const nearby =
			finding.startLine <= prior.endLine + lineTolerance &&
			finding.endLine >= prior.startLine - lineTolerance;
		// 0.4 is a paraphrase of the same failure ("division by zero" / "division by zero when
		// b is 0"). A second bug that only shares the lines, such as a TTL reset next to an
		// eviction on a requeue, stays below it.
		return nearby && titleSimilarity(prior.title, finding.title) >= 0.4;
	});
}
