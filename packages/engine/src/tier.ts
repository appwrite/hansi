import { severities, tiers, worseTier, type Severity, type Tier } from './grading';

// The tier grades merge confidence. The model proposes one; open findings cap how good it can
// be, so a pull request with a critical finding never reads as ready to merge.

const cap: Record<Severity, Tier> = {
	info: 'S',
	minor: 'A',
	major: 'B',
	critical: 'D'
};

/** The best tier the open findings allow. */
export function tierCap(open: Severity[]): Tier {
	return open.reduce<Tier>((best, severity) => worseTier(best, cap[severity]), 'S');
}

/** The model's tier, or the cap when the model's is better than the findings allow. */
export function finalTier(proposed: Tier | undefined, open: Severity[]): Tier {
	const limit = tierCap(open);
	return proposed ? worseTier(proposed, limit) : limit;
}

/** The tier after findings change outside a review, e.g. a thread dismissed, with its reason. */
export function standing(open: { severity: Severity; title: string }[]): {
	tier: Tier;
	reason: string;
} {
	const worst = [...open].sort(
		(a, b) => severities.indexOf(b.severity) - severities.indexOf(a.severity)
	)[0];
	if (!worst || worst.severity === 'info') return { tier: tiers[0], reason: '' };
	return {
		tier: tierCap(open.map((f) => f.severity)),
		reason: `Limited by an open ${worst.severity} finding: ${worst.title}`
	};
}
