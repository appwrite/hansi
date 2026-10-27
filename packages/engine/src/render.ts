import type { RepoConfig } from './config';
import type { ReviewFinding } from './findings';
import { tierMeaning, type Severity, type Tier } from './grading';
import type { ReviewResult } from './review';
import { withheldApprovalReason } from './verdict';

// What a review looks like on GitHub: the review body and one inline comment per finding.

const tierIcon: Record<Tier, string> = { S: '🟢', A: '🟢', B: '🟡', C: '🟠', D: '🔴', F: '🔴' };
const severityIcon: Record<Severity, string> = {
	info: '🔵',
	minor: '🟡',
	major: '🟠',
	critical: '🔴'
};

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A fence longer than any backtick run in `code`, so the code cannot close it. */
function fence(code: string): string {
	const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
	return '`'.repeat(Math.max(3, longest + 1));
}

/** Table cells cannot hold pipes or line breaks. */
function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

export function renderFinding(finding: ReviewFinding): string {
	const parts = [`**${finding.title}**`, finding.body];
	if (finding.suggestion !== undefined) {
		const marker = fence(finding.suggestion);
		parts.push(`${marker}suggestion\n${finding.suggestion}\n${marker}`);
	}
	parts.push(
		`<sub>${severityIcon[finding.severity]} ${capitalized(finding.severity)} · ${finding.category}</sub>`
	);
	return parts.join('\n\n');
}

export function renderReviewBody(
	result: ReviewResult,
	options: { config: RepoConfig; configErrors?: string[] }
): string {
	const parts = [`## ${tierIcon[result.tier]} Tier ${result.tier} · ${tierMeaning[result.tier]}`];
	if (result.tierReason) parts.push(`> ${result.tierReason.replace(/\n/g, '\n> ')}`);
	parts.push(result.summary);

	if (result.verdict === 'comment') {
		const withheld = withheldApprovalReason(result.findings, options.config);
		if (withheld) parts.push(withheld + '.');
	}
	const unposted = result.dropped.filter((f) => f.reason === 'Over the comment limit');
	if (unposted.length) {
		const list = unposted.map((f) => `- ${f.path}:${f.startLine} ${f.title}`).join('\n');
		parts.push(`More findings than the comment limit allows:\n${list}`);
	}
	if (result.partial) {
		parts.push('Some changed files were not reviewed, so this review does not approve.');
	}

	if (result.walkthrough.length) {
		const rows = result.walkthrough.map((f) => `| \`${cell(f.path)}\` | ${cell(f.summary)} |`);
		parts.push(
			`<details>\n<summary><b>Walkthrough</b> · ${result.walkthrough.length}</summary>\n\n| File | Change |\n| :-- | :-- |\n${rows.join('\n')}\n\n</details>`
		);
	}
	if (result.notShown.length) {
		const rows = result.notShown.map((f) => `- \`${f.path}\` (${f.reason})`);
		parts.push(
			`<details>\n<summary><b>Not reviewed</b> · ${result.notShown.length}</summary>\n\n${rows.join('\n')}\n\n</details>`
		);
	}
	if (options.configErrors?.length) {
		const rows = options.configErrors.map((error) => `- ${error}`).join('\n');
		parts.push(`The repository's review settings could not be used, so defaults applied:\n${rows}`);
	}
	return parts.join('\n\n');
}
