import { severities, tiers, type Severity, type Tier } from './config';

export { tierMeaning, tiers, type Tier } from './config';

/** The best tier a PR can get with a finding of this severity still open. */
const capBySeverity: Record<Severity, Tier> = {
	// Informational notes don't stand in the way of merging.
	info: 'S',
	minor: 'A',
	major: 'B',
	critical: 'D'
};

/** Best tier allowed by the open findings: the worst severity decides. */
export function tierCap(openSeverities: Severity[]): Tier {
	const worst = openSeverities.reduce<Severity | null>(
		(acc, s) => (acc === null || severities.indexOf(s) > severities.indexOf(acc) ? s : acc),
		null
	);
	return worst ? capBySeverity[worst] : 'S';
}

/** The model's grade, but never better than the findings allow. */
export function finalTier(modelTier: Tier | undefined, cap: Tier): Tier {
	if (!modelTier) return cap;
	return tiers.indexOf(modelTier) > tiers.indexOf(cap) ? modelTier : cap;
}

/**
 * Tier and reason after findings change outside a full review (e.g. a thread dismissal).
 * With nothing open the PR is mergeable; otherwise the worst remaining finding caps the grade.
 */
export function standingFromOpenFindings(open: { severity: Severity; title: string }[]): {
	tier: Tier;
	tierReason: string;
} {
	if (open.length === 0) return { tier: 'S', tierReason: '' };
	const worst = open.reduce((a, b) =>
		severities.indexOf(b.severity) > severities.indexOf(a.severity) ? b : a
	);
	return {
		tier: tierCap(open.map((f) => f.severity)),
		tierReason: `Limited by an open ${worst.severity} finding: ${worst.title}`
	};
}
