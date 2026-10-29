import {
	blockingSeverity,
	severityAtLeast,
	type RepoConfig,
	type Severity,
	type Verdict
} from './config';
import type { categories } from './findings';
import { compareSeverity } from './findings';

export type { Verdict } from './config';

/**
 * Defect categories. A finding in one of these, at minor or above, withholds approval even when
 * it is below `reviews.requestChanges`. Testing, documentation, maintainability, and performance
 * notes do not. There is no data-loss or race category: data loss is reported as `bug`, and races
 * as `concurrency`.
 */
const defectCategories = [
	'bug',
	'security',
	'concurrency',
	'error-handling'
] as const satisfies readonly (typeof categories)[number][];

const defectCategorySet = new Set<string>(defectCategories);

export interface VerdictFinding {
	severity: Severity;
	category?: string;
	title?: string;
}

export interface VerdictInput {
	/** Findings posted by this review. */
	posted: VerdictFinding[];
	/** Findings from earlier reviews that are still unresolved after this one. */
	stillOpen: VerdictFinding[];
	config: RepoConfig;
}

function isDefectFinding(finding: VerdictFinding): boolean {
	return (
		!!finding.category &&
		defectCategorySet.has(finding.category) &&
		severityAtLeast(finding.severity, 'minor')
	);
}

/**
 * GitHub shows each reviewer's latest approve / request-changes review, so the verdict must
 * reflect the whole PR, not just the newest commits:
 * - new findings at or above `requestChanges` → request changes (or only comment when that
 *   setting is `never`)
 * - findings from earlier reviews still open at that severity → comment, which leaves the
 *   earlier "changes requested" in place
 * - an open bug, security, concurrency, or error-handling finding at minor or above, including
 *   one below that threshold and one still open from an earlier review → comment, never approve
 * - otherwise → approve (minor testing, documentation, and maintainability notes are fine),
 *   unless `approve: false`
 *
 * Info-level notes do not withhold approval.
 */
export function decideVerdict({ posted, stillOpen, config }: VerdictInput): Verdict {
	const threshold = blockingSeverity(config);
	const blocking = posted.some((finding) => severityAtLeast(finding.severity, threshold));
	if (blocking) return config.reviews.requestChanges === 'never' ? 'comment' : 'request_changes';
	if (stillOpen.some((finding) => severityAtLeast(finding.severity, threshold))) return 'comment';
	if ([...posted, ...stillOpen].some(isDefectFinding)) return 'comment';
	return config.reviews.approve ? 'approve' : 'comment';
}

/**
 * Why approval was withheld for an open defect below the blocking threshold, or null when that
 * rule did not apply (nothing like it is open, or a finding already meets the threshold).
 */
export function openDefectApprovalReason(
	findings: VerdictFinding[],
	config: RepoConfig
): string | null {
	const threshold = blockingSeverity(config);
	if (findings.some((finding) => severityAtLeast(finding.severity, threshold))) return null;
	const defect = findings.filter(isDefectFinding).sort(compareSeverity)[0];
	if (!defect) return null;
	const title = defect.title?.trim();
	return title
		? `Not approving while a bug finding is open: ${title}`
		: 'Not approving while a bug finding is open.';
}
