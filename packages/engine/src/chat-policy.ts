import type { categories } from './findings';

/**
 * GitHub `author_association` values that can write to the repository. Same set as comment
 * triggers: a CONTRIBUTOR or NONE login does not get to close a finding by preference.
 */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Minor notes a maintainer may decline. Defects are not in this set. */
const DECLINABLE_CATEGORIES = new Set<string>(['testing', 'documentation', 'maintainability']);

const NOTE_SEVERITIES = new Set<string>(['minor', 'info']);

/**
 * Bug-like categories. A reasoned "we don't want this" does not close these, and a guideline
 * edit in the pull request does not replace the base-branch rule for them.
 */
const DEFECT_CATEGORIES = [
	'bug',
	'security',
	'concurrency',
	'error-handling'
] as const satisfies readonly (typeof categories)[number][];

const defectCategories = new Set<string>(DEFECT_CATEGORIES);

export function isTrustedCommenter(authorAssociation: string | undefined): boolean {
	return !!authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation);
}

export function isDefectCategory(category: string): boolean {
	return defectCategories.has(category);
}

export interface ChatPolicyFinding {
	severity: string;
	category: string;
}

/**
 * How a reply on a finding should be treated. Prompt text is chosen from this so the model is
 * told the outcome instead of re-deciding who counts as a maintainer.
 */
export interface ChatReplyPolicy {
	/** Minor or info testing, documentation, or maintainability note from a trusted commenter. */
	acceptReasonedDecline: boolean;
	/** Trusted commenter, but the finding is a bug, security, concurrency, or error-handling issue. */
	holdDefect: boolean;
	/**
	 * A held defect that is not security. The commenter may still settle it by confirming the
	 * change is deliberate, such as a documented breaking change to a public API. The model checks
	 * that the finding is about a choice the pull request makes, not code that misbehaves.
	 */
	acceptDeliberateChange: boolean;
	/**
	 * Trusted commenter and a non-defect finding, and this pull request edits a guideline file.
	 * The model still checks that the finding cites that file.
	 */
	deferToGuidelineEdit: boolean;
}

function isDeclinableNote(
	finding: ChatPolicyFinding | null | undefined
): finding is ChatPolicyFinding {
	return (
		!!finding &&
		NOTE_SEVERITIES.has(finding.severity) &&
		DECLINABLE_CATEGORIES.has(finding.category)
	);
}

/** True when a trusted commenter may dismiss this note on a reasoned first reply. */
export function acceptsReasonedDecline(
	authorAssociation: string | undefined,
	finding: ChatPolicyFinding | null | undefined
): boolean {
	return isTrustedCommenter(authorAssociation) && isDeclinableNote(finding);
}

/**
 * True when a trusted commenter's edit to a guideline file can settle a non-defect finding.
 * Bug and security findings (and the other defect categories) keep the base-branch rule.
 */
export function defersToGuidelineChange(
	authorAssociation: string | undefined,
	finding: ChatPolicyFinding | null | undefined
): boolean {
	return isTrustedCommenter(authorAssociation) && !!finding && !isDefectCategory(finding.category);
}

export function chatReplyPolicy(input: {
	authorAssociation?: string;
	finding?: ChatPolicyFinding | null;
	changedGuidelines?: readonly string[];
}): ChatReplyPolicy {
	const finding = input.finding ?? undefined;
	const trusted = isTrustedCommenter(input.authorAssociation);
	return {
		acceptReasonedDecline: acceptsReasonedDecline(input.authorAssociation, finding),
		holdDefect: trusted && !!finding && isDefectCategory(finding.category),
		acceptDeliberateChange:
			trusted && !!finding && isDefectCategory(finding.category) && finding.category !== 'security',
		deferToGuidelineEdit:
			defersToGuidelineChange(input.authorAssociation, finding) &&
			(input.changedGuidelines?.length ?? 0) > 0
	};
}
