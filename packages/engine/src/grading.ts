// The scales a review is graded on. Order matters: each list runs from mildest to worst, or for
// tiers from best to worst, and comparisons use the position.

export const severities = ['info', 'minor', 'major', 'critical'] as const;
export type Severity = (typeof severities)[number];

export const categories = [
	'bug',
	'security',
	'concurrency',
	'error-handling',
	'performance',
	'maintainability',
	'testing',
	'documentation'
] as const;
export type Category = (typeof categories)[number];

/** Merge confidence for the whole pull request, best first. */
export const tiers = ['S', 'A', 'B', 'C', 'D', 'F'] as const;
export type Tier = (typeof tiers)[number];

export const tierMeaning: Record<Tier, string> = {
	S: 'Ready to merge',
	A: 'Mergeable after minor fixes',
	B: 'Needs changes before merging',
	C: 'Significant problems',
	D: 'Serious problems',
	F: 'Do not merge'
};

export const verdicts = ['approve', 'request_changes', 'comment'] as const;
export type Verdict = (typeof verdicts)[number];

export function isAtLeast(severity: Severity, minimum: Severity): boolean {
	return severities.indexOf(severity) >= severities.indexOf(minimum);
}

/** Sorts worst first. */
export function bySeverity(a: { severity: Severity }, b: { severity: Severity }): number {
	return severities.indexOf(b.severity) - severities.indexOf(a.severity);
}

/** The worse of two tiers. */
export function worseTier(a: Tier, b: Tier): Tier {
	return tiers.indexOf(a) >= tiers.indexOf(b) ? a : b;
}
