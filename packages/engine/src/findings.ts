import { z } from 'zod';
import { commentableLines, hunkOf, type FileDiff } from './diff';
import { bySeverity, categories, severities } from './grading';

/** Optional, and null counts as absent: models send null for "no value", and one null must not void a submission. */
export function optional<T extends z.ZodType>(schema: T) {
	return schema
		.nullish()
		.transform((value) => value ?? undefined)
		.optional();
}

export const findingSchema = z.object({
	path: z.string().describe('File path exactly as in the diff header'),
	startLine: z.number().int().positive().describe('First new-file line the finding is about'),
	endLine: z
		.number()
		.int()
		.positive()
		.describe('Last new-file line, in the same hunk as startLine'),
	severity: z.enum(severities),
	category: z.enum(categories),
	title: z.string().describe('One line, under 80 characters'),
	body: z.string().describe('What goes wrong and when. Markdown, no headings.'),
	suggestion: optional(z.string()).describe(
		'Only code. GitHub replaces lines startLine to endLine with it verbatim when the author applies it, so it must be the complete, correctly indented replacement for exactly those lines. Leave it out unless the fix is small, local and certain.'
	)
});

export type ReviewFinding = z.infer<typeof findingSchema>;

export interface Dropped extends ReviewFinding {
	reason: string;
}

/**
 * Puts a finding on lines GitHub accepts a comment on, or returns null. The end line must be
 * commentable. A start line in another hunk, or not commentable, collapses the comment onto
 * the end line, since a multi-line comment cannot cross hunks.
 */
export function placeFinding(finding: ReviewFinding, files: FileDiff[]): ReviewFinding | null {
	const file = files.find((f) => f.path === finding.path);
	if (!file) return null;
	const lines = commentableLines(file);
	const end = Math.max(finding.startLine, finding.endLine);
	if (!lines.has(end)) return null;
	const start = Math.min(finding.startLine, finding.endLine);
	const sameHunk = lines.has(start) && hunkOf(file, start) === hunkOf(file, end);
	return { ...finding, startLine: sameHunk ? start : end, endLine: end };
}

function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 3)
	);
}

/** Share of words two titles have in common (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
	const left = words(a);
	const right = words(b);
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared++;
	return shared / (left.size + right.size - shared);
}

export interface Located {
	path: string;
	startLine: number;
	endLine: number;
	title: string;
}

/**
 * Whether a finding repeats one already reported: same file, lines within a few of each other
 * (code moves between pushes), and a title describing the same failure. Sharing lines alone is
 * not enough: a second bug on the same lines is a new finding.
 */
export function isDuplicate(finding: Located, earlier: Located[], tolerance = 3): boolean {
	return earlier.some(
		(prior) =>
			prior.path === finding.path &&
			finding.startLine <= prior.endLine + tolerance &&
			finding.endLine >= prior.startLine - tolerance &&
			titleSimilarity(prior.title, finding.title) >= 0.4
	);
}

/** Keeps the most severe copy of each finding and reports the rest as dropped. */
export function dedupe(findings: ReviewFinding[], dropped: Dropped[]): ReviewFinding[] {
	const kept: ReviewFinding[] = [];
	for (const finding of [...findings].sort(bySeverity)) {
		if (isDuplicate(finding, kept))
			dropped.push({ ...finding, reason: 'Duplicate in this review' });
		else kept.push(finding);
	}
	return kept;
}
