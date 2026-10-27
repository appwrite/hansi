import { blockingSeverity, type RepoConfig } from './config';
import { bySeverity, isAtLeast, type Category, type Severity, type Verdict } from './grading';

// The review's GitHub verdict is decided here, from the findings, never by the model. GitHub
// keeps each reviewer's latest approve or request-changes review, so the verdict speaks for the
// whole pull request, not only the commits this review looked at.

/** Categories that are defects: one of these at minor or above keeps a review from approving. */
const defects = new Set<Category>(['bug', 'security', 'concurrency', 'error-handling']);

export interface GradedFinding {
	severity: Severity;
	category: Category;
	title: string;
}

export interface VerdictInput {
	/** Findings this review posts. */
	posted: GradedFinding[];
	/** Findings from earlier reviews that are still unresolved. */
	open: GradedFinding[];
	config: RepoConfig;
	/**
	 * The author can push to the repository. Without write access an approval is withheld
	 * unless the repository allows it: their code could argue the model into one.
	 */
	trustedAuthor: boolean;
	/** The review saw only part of the diff (too large, or a file failed). It never approves. */
	partial: boolean;
}

function isDefect(finding: GradedFinding): boolean {
	return defects.has(finding.category) && isAtLeast(finding.severity, 'minor');
}

export function decideVerdict(input: VerdictInput): Verdict {
	const { posted, open, config } = input;
	const blocking = blockingSeverity(config);

	if (posted.some((f) => isAtLeast(f.severity, blocking))) {
		return config.reviews.requestChanges === 'never' ? 'comment' : 'request_changes';
	}
	// Commenting leaves an earlier "changes requested" standing.
	if (open.some((f) => isAtLeast(f.severity, blocking))) return 'comment';
	if ([...posted, ...open].some(isDefect)) return 'comment';
	if (!config.reviews.approve || input.partial) return 'comment';
	if (!input.trustedAuthor && !config.reviews.approveOutsideContributors) return 'comment';
	return 'approve';
}

/** Why a review only commented over an open defect below the blocking severity, or null. */
export function withheldApprovalReason(
	findings: GradedFinding[],
	config: RepoConfig
): string | null {
	const blocking = blockingSeverity(config);
	if (findings.some((f) => isAtLeast(f.severity, blocking))) return null;
	const worst = findings.filter(isDefect).sort(bySeverity)[0];
	if (!worst) return null;
	return `Not approving while a ${worst.category} finding is open: ${worst.title}`;
}
