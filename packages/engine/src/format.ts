import type { Severity, Tier, Verdict } from './config';
import { isUnattachedDrop, type DroppedFinding, type Finding } from './findings';
import { tierMeaning } from './tier';

/**
 * Namespace of every hidden marker Hansi writes into GitHub comments. It differs from
 * hansi.codes' `hans`, so both can review the same pull request without either one finding and
 * editing the other's comments.
 */
export const MARKER_NAMESPACE = 'appwrite-hansi';

/** Hidden marker that identifies Hansi's summary comment, so each review edits it in place. */
export const SUMMARY_MARKER = `<!-- ${MARKER_NAMESPACE}:summary -->`;

/**
 * Hidden marker on the summary note that the pull request head moved during the review.
 * Settlement rebuilds the comment from its body, and this keeps the note distinct from a
 * withheld-approval note.
 */
export const STALE_HEAD_NOTE_MARK = `<!-- ${MARKER_NAMESPACE}:stale-head -->`;

const severityIcon: Record<Severity, string> = {
	critical: '🔴',
	major: '🟠',
	minor: '🟡',
	info: '🔵'
};

const severityName: Record<Severity, string> = {
	critical: 'Critical',
	major: 'Major',
	minor: 'Minor',
	info: 'Info'
};

const tierIcon: Record<Tier, string> = {
	S: '🟢',
	A: '🔵',
	B: '🟡',
	C: '🟠',
	D: '🔴',
	F: '⛔'
};

const verdictText: Record<Verdict, string> = {
	approve: '✅ Approved',
	request_changes: '🛑 Changes requested',
	comment: '💬 Commented'
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Makes text safe inside a Markdown table cell. */
function cell(text: string) {
	return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** The repository's web page (`https://github.com/<owner>/<name>`) and the commit file links point at. */
export interface FilePermalink {
	repository: string;
	headSha: string;
}

/**
 * Rewrites relative repo-file links to absolute blob permalinks at `sha`.
 * Link targets with a scheme, a leading `/` or `#`, or a `..` segment stay as written.
 * Fenced and inline code is left unchanged, so suggestion blocks and examples are not rewritten.
 */
export function absolutizeLinks(markdown: string, repository: string, sha: string): string {
	if (!repository || !sha) return markdown;
	const { text, restore } = maskCode(markdown);
	return restore(rewriteMarkdownLinks(text, repository, sha));
}

/** Inline links only. Image syntax (`![alt](path)`) is left as written. */
function rewriteMarkdownLinks(prose: string, repository: string, sha: string): string {
	let out = '';
	let i = 0;
	while (i < prose.length) {
		if (prose[i] === '[' && prose[i - 1] !== '!') {
			const link = readMarkdownLink(prose, i);
			const dest = link && parseLinkDestination(link.rawDest);
			const url = dest && repoFileUrl(dest.href, repository, sha);
			if (link && dest && url) {
				out += `[${link.label}](${url}${dest.suffix})`;
				i = link.end;
				continue;
			}
		}
		out += prose.charAt(i);
		i++;
	}
	return out;
}

function readMarkdownLink(
	text: string,
	start: number
): { label: string; rawDest: string; end: number } | null {
	let i = start + 1;
	let label = '';
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\' && i + 1 < text.length) {
			label += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === ']') break;
		label += ch ?? '';
		i++;
	}
	if (text[i] !== ']' || text[i + 1] !== '(') return null;
	const dest = readRawDestination(text, i + 1);
	if (!dest) return null;
	return { label, rawDest: dest.rawDest, end: dest.end };
}

/**
 * The inside of a markdown link's `(...)`, including a title. Parentheses in the path
 * are balanced, so `src/foo(bar).ts` is one destination rather than a truncated one.
 */
function readRawDestination(
	text: string,
	openParen: number
): { rawDest: string; end: number } | null {
	let i = openParen + 1;
	if (text[i] === '<') {
		const close = text.indexOf('>', i + 1);
		if (close === -1 || text.slice(i, close).includes('\n')) return null;
		i = close + 1;
	} else {
		let depth = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === '\n' || ch === undefined) return null;
			if (ch === '\\' && i + 1 < text.length) {
				i += 2;
				continue;
			}
			if (ch === '(') {
				depth++;
				i++;
				continue;
			}
			if (ch === ')') {
				if (depth === 0) break;
				depth--;
				i++;
				continue;
			}
			if ((ch === ' ' || ch === '\t') && depth === 0) break;
			i++;
		}
	}
	if (text[i] === ' ' || text[i] === '\t') {
		let j = i;
		while (text[j] === ' ' || text[j] === '\t') j++;
		if (text[j] !== ')') {
			const titleEnd = readLinkTitle(text, j);
			if (titleEnd === null) return null;
			i = titleEnd;
			while (text[i] === ' ' || text[i] === '\t') i++;
		}
	}
	if (text[i] !== ')') return null;
	return { rawDest: text.slice(openParen + 1, i), end: i + 1 };
}

function readLinkTitle(text: string, start: number): number | null {
	const quote = text[start];
	if (quote !== '"' && quote !== "'" && quote !== '(') return null;
	const closer = quote === '(' ? ')' : quote;
	let i = start + 1;
	let depth = quote === '(' ? 1 : 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\n' || ch === undefined) return null;
		if (ch === '\\' && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (quote === '(' && ch === '(') {
			depth++;
			i++;
			continue;
		}
		if (ch === closer) {
			if (quote !== '(' || depth === 1) return i + 1;
			depth--;
		}
		i++;
	}
	return null;
}

function repoFileUrl(href: string, repository: string, sha: string): string | null {
	let target = href.trim();
	if (!target || target.startsWith('#') || target.startsWith('/') || target.startsWith('?')) {
		return null;
	}

	const hashAt = target.indexOf('#');
	const hash = hashAt === -1 ? '' : target.slice(hashAt);
	target = hashAt === -1 ? target : target.slice(0, hashAt);
	const queryAt = target.indexOf('?');
	const query = queryAt === -1 ? '' : target.slice(queryAt);
	let path = queryAt === -1 ? target : target.slice(0, queryAt);

	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
	path = path.replace(/^(?:\.\/)+/, '');
	const segments = path.split('/').filter((segment) => segment !== '.');
	if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '..')) {
		return null;
	}

	const encoded = segments.map(encodePathSegment).join('/');
	return `${repository}/${sha}/${encoded}${query}${hash}`;
}

/** `encodeURIComponent` leaves parentheses, which would close the markdown link. */
function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/[()]/g, (ch) => (ch === '(' ? '%28' : '%29'));
}

function parseLinkDestination(raw: string): { href: string; suffix: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('<')) {
		const end = trimmed.indexOf('>');
		if (end === -1) return null;
		return { href: trimmed.slice(1, end).trim(), suffix: trimmed.slice(end + 1) };
	}
	const ws = trimmed.search(/\s/);
	if (ws === -1) return { href: trimmed, suffix: '' };
	return { href: trimmed.slice(0, ws), suffix: trimmed.slice(ws) };
}

/** Hides fenced and inline code from the link rewriter, then puts it back. */
function maskCode(markdown: string): { text: string; restore: (value: string) => string } {
	const blocks: string[] = [];
	const stash = (block: string) => {
		const token = `\uE000${blocks.length}\uE000`;
		blocks.push(block);
		return token;
	};

	let text = '';
	let i = 0;
	while (i < markdown.length) {
		const atLineStart = i === 0 || markdown[i - 1] === '\n';
		if (atLineStart && (markdown[i] === '`' || markdown[i] === '~')) {
			const fence = readFence(markdown, i);
			if (fence) {
				text += stash(fence);
				i += fence.length;
				continue;
			}
		}
		if (markdown[i] === '`') {
			const inline = readInlineCode(markdown, i);
			if (inline) {
				text += stash(inline);
				i += inline.length;
				continue;
			}
		}
		text += markdown.charAt(i);
		i++;
	}

	return {
		text,
		restore: (value) =>
			value.replace(/\uE000(\d+)\uE000/g, (_, index) => blocks[Number(index)] ?? '')
	};
}

function readFence(markdown: string, start: number): string | null {
	const lineEnd = markdown.indexOf('\n', start);
	if (lineEnd === -1) return null;
	const openLine = markdown.slice(start, lineEnd);
	const opened = /^(`{3,}|~{3,})/.exec(openLine);
	const fence = opened?.[1];
	if (!fence) return null;
	const marker = fence[0];
	const size = fence.length;
	if (!marker || (marker === '`' && openLine.slice(size).includes('`'))) return null;

	let i = lineEnd + 1;
	const close = new RegExp(`^\\${marker}{${size},}[ \\t]*$`);
	while (i < markdown.length) {
		const end = markdown.indexOf('\n', i);
		const line = end === -1 ? markdown.slice(i) : markdown.slice(i, end);
		if (close.test(line)) return markdown.slice(start, end === -1 ? markdown.length : end);
		if (end === -1) return null;
		i = end + 1;
	}
	return null;
}

function readInlineCode(markdown: string, start: number): string | null {
	const opened = /^`+/.exec(markdown.slice(start));
	if (!opened) return null;
	const ticks = opened[0];
	let i = start + ticks.length;
	while (i < markdown.length) {
		const idx = markdown.indexOf(ticks, i);
		if (idx === -1) return null;
		if (markdown[idx + ticks.length] === '`') {
			i = idx + ticks.length;
			while (markdown[i] === '`') i++;
			continue;
		}
		return markdown.slice(start, idx + ticks.length);
	}
	return null;
}

function withPermalinks<T extends { title: string; body?: string }>(
	finding: T,
	permalink: FilePermalink
): T {
	return {
		...finding,
		title: absolutizeLinks(finding.title, permalink.repository, permalink.headSha),
		...(finding.body !== undefined
			? { body: absolutizeLinks(finding.body, permalink.repository, permalink.headSha) }
			: {})
	};
}

/**
 * The instruction Greptile-style agents already follow. Kept verbatim so a copied prompt is
 * enough to fix the finding without any Hansi-specific skill.
 */
const agentFixInstruction =
	'For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.';

/** `34` for one line, `143-145` for a range. */
function lineRef(start: number, end = start) {
	return end === start ? `${start}` : `${start}-${end}`;
}

/** A markdown fence long enough that backticks inside `content` cannot close it. */
function fencedMarkdown(content: string) {
	const runs = content.match(/`+/g);
	const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
	const fence = '`'.repeat(Math.max(5, longest + 1));
	return `${fence}markdown\n${content.replace(/\n$/, '')}\n${fence}`;
}

/** A collapsed block an agent can copy and follow. */
function agentPromptBlock(summary: string, prompt: string) {
	return `<details><summary>${summary}</summary>\n\n${fencedMarkdown(prompt)}\n\n</details>`;
}

function suggestionFence(suggestion: string) {
	return '```suggestion\n' + suggestion.replace(/\n$/, '') + '\n```';
}

/** Title, explanation, and the GitHub suggestion, in the order a reader sees them. */
function findingText(finding: Pick<Finding, 'title' | 'body' | 'suggestion'>): string {
	const parts = [`**${finding.title}**`];
	if (finding.body) parts.push(finding.body);
	if (finding.suggestion !== undefined) parts.push(suggestionFence(finding.suggestion));
	return parts.join('\n\n');
}

/** One finding, as a self-contained prompt for an agent that only sees this comment. */
function inlineAgentPrompt(finding: Finding): string {
	return [
		'This is a comment left during a code review.',
		`Path: ${finding.path}`,
		`Line: ${lineRef(finding.startLine, finding.endLine)}`,
		'',
		'Comment:',
		findingText(finding),
		'',
		'---',
		'',
		agentFixInstruction
	].join('\n');
}

interface AgentIssue {
	path: string;
	startLine: number;
	endLine?: number;
	title: string;
	body?: string;
	suggestion?: string;
}

/** Every open finding, as one prompt an agent can use to fix the pull request. */
function summaryAgentPrompt(issues: AgentIssue[]): string {
	const blocks = issues.map((issue, index) => {
		const lines = [
			`### Issue ${index + 1}`,
			`${issue.path}:${lineRef(issue.startLine, issue.endLine ?? issue.startLine)}`,
			`**${issue.title}**`
		];
		if (issue.body) lines.push('', issue.body);
		if (issue.suggestion !== undefined) lines.push('', suggestionFence(issue.suggestion));
		return lines.join('\n');
	});
	return [...blocks, `---\n\n${agentFixInstruction}`].join('\n\n');
}

/** An inline review comment: title, explanation, optional suggestion, an agent prompt, then metadata. */
export function formatFindingComment(finding: Finding, permalink?: FilePermalink): string {
	const linked = permalink ? withPermalinks(finding, permalink) : finding;
	return [
		findingText(linked),
		agentPromptBlock('Prompt To Fix With AI', inlineAgentPrompt(linked)),
		`<sub>${severityIcon[linked.severity]} ${severityName[linked.severity]} · ${linked.category} · Reply if this doesn't apply.</sub>`
	].join('\n\n');
}

/**
 * A finding posted on its whole file, because GitHub shows no diff for the file and takes no line
 * comment there. The line goes in the text instead.
 */
export function formatFileFindingComment(finding: Finding, permalink?: FilePermalink): string {
	const range =
		finding.startLine < finding.endLine
			? `Lines ${finding.startLine}-${finding.endLine}`
			: `Line ${finding.endLine}`;
	return `**${range}** · GitHub does not show this file's diff, so this comment is on the file.\n\n${formatFindingComment(finding, permalink)}`;
}

export interface SummaryInput {
	repository: string;
	headSha: string;
	summary: string;
	tier: Tier;
	tierReason: string;
	verdict: Verdict;
	posted: Finding[];
	/** Earlier findings the new commits fixed. */
	resolved: { path: string; startLine: number; title: string }[];
	/** Earlier findings that are still open. Body, end line, and suggestion are included when known. */
	stillOpen: {
		path: string;
		startLine: number;
		endLine?: number;
		title: string;
		body?: string;
		suggestion?: string | null;
		severity: Severity;
	}[];
	dropped: DroppedFinding[];
	walkthrough: { path: string; change: string }[];
	/** Incremental reviews: what the newest commits changed. */
	latestChanges?: string | null;
	/** Why Hansi did not approve although nothing is blocking. */
	approvalWithheld?: string | null;
	/**
	 * Reviewable changed files that did not fit in the prompt, out of how many were considered.
	 * Absent or null when every reviewable file was included.
	 */
	filesTooLargeForPrompt?: { omitted: number; total: number } | null;
	/**
	 * Set when the head moved after this review started. Newer commits exist and will be
	 * reviewed; this review did not approve the commit it read.
	 */
	staleHead?: string | null;
	incrementalFrom?: string;
	/**
	 * Replaces the "Reviewed …" footer sentence. Set when a merge of the base branch did not
	 * change this pull request's code.
	 */
	scope?: string;
	detailsUrl?: string;
	/** The bot's handle, e.g. `@hansi-codes`. */
	mention: string;
	/** The Console's origin, where the status images are served. Absent: the status is text. */
	images?: string;
}

/**
 * The state images Appwrite's Sites and Functions comments show, served by the Appwrite Console
 * under `/images/vcs/`: queued, running (animated), finished and failed.
 */
export type StatusImage = 'waiting' | 'building' | 'ready' | 'failed';

/**
 * A status cell in the style of Appwrite's deployment comments: the state image (light and dark)
 * and the label in italics. `images` is the Console's origin; without it, or with no image for
 * this state, the cell is the label alone, as Appwrite writes it for providers that cannot show
 * images from another host.
 */
export function statusCell(image: StatusImage | null, label: string, images?: string): string {
	const text = `_${label}_`;
	if (!image || !images) return text;
	const extension = image === 'building' ? 'gif' : 'png';
	const src = (theme: 'light' | 'dark') =>
		`${images}/images/vcs/status-${image}-${theme}.${extension}`;
	const alt = label.replace(/"/g, '&quot;');
	return `<picture><source media="(prefers-color-scheme: dark)" srcset="${src('dark')}"><img alt="${alt}" width="85" align="center" src="${src('light')}"></picture> ${text}`;
}

/** A collapsible section, as Appwrite's deployment comments group Sites and Functions. */
export function detailsSection(title: string, count: number, body: string, open = false): string {
	return `<details${open ? ' open' : ''}>\n<summary>${title} (${count})</summary>\n\n<br>\n\n${body}\n\n</details>`;
}

/** The closing tip: how to ask for another review or a question. */
export function interactionTip(mention: string): string {
	return `> [!TIP]\n> Comment <code>${mention} review</code> to re-run, or mention <code>${mention}</code> with a question.`;
}

/**
 * Ends the latest-changes paragraph, which can span lines, so a settlement rebuild can read it back
 * whatever follows it.
 */
const LATEST_CHANGES_END = `<!-- /${MARKER_NAMESPACE}:latest-changes -->`;

/** Reads the latest-changes paragraph back out of a summary comment. */
export function latestChangesFromBody(body: string): string | null {
	const current = body.match(
		new RegExp(`\\*\\*Latest changes:\\*\\* ([\\s\\S]*?)\\n${LATEST_CHANGES_END}`)
	)?.[1];
	if (current !== undefined) return current;
	// Summaries written before the restyle ended the paragraph at the verdict table.
	return body.match(/\*\*Latest changes:\*\* ([\s\S]*?)\n\n\| Verdict \|/)?.[1] ?? null;
}

/** The summary comment Hansi keeps up to date on every pull request. */
export function formatSummaryComment(input: SummaryInput): string {
	const permalink = { repository: input.repository, headSha: input.headSha };
	const link = (text: string) => absolutizeLinks(text, permalink.repository, permalink.headSha);
	input = {
		...input,
		summary: link(input.summary),
		tierReason: link(input.tierReason),
		latestChanges: input.latestChanges == null ? input.latestChanges : link(input.latestChanges),
		approvalWithheld:
			input.approvalWithheld == null ? input.approvalWithheld : link(input.approvalWithheld),
		posted: input.posted.map((finding) => withPermalinks(finding, permalink)),
		stillOpen: input.stillOpen.map((finding) => withPermalinks(finding, permalink)),
		dropped: input.dropped.map((finding) => withPermalinks(finding, permalink)),
		resolved: input.resolved.map((finding) => ({ ...finding, title: link(finding.title) })),
		walkthrough: input.walkthrough.map((row) => ({ ...row, change: link(row.change) }))
	};
	const lineLink = (path: string, start: number, end = start) =>
		`[\`${path}:${start}\`](${input.repository}/${input.headSha}/${path}#L${start}${end > start ? `-L${end}` : ''})`;

	// The head row, laid out like a deployment row in Appwrite's Sites and Functions comments.
	// The sections below carry the finding counts.
	const columns = ['Commit', 'Status', 'Tier', 'Verdict'];
	const row = [
		`\`${input.headSha.slice(0, 7)}\``,
		statusCell('ready', 'Reviewed', input.images),
		`${tierIcon[input.tier]} **${input.tier}** · ${tierMeaning[input.tier]}`,
		verdictText[input.verdict]
	];
	if (input.detailsUrl) {
		columns.push('Details');
		row.push(`[View review](${input.detailsUrl})`);
	}

	const parts = [
		SUMMARY_MARKER,
		'## Code review',
		[
			`| ${columns.join(' | ')} |`,
			`| ${columns.map(() => ':-').join(' | ')} |`,
			`| ${row.join(' | ')} |`
		].join('\n')
	];
	if (input.tierReason) parts.push(`> ${cell(input.tierReason)}`);
	parts.push(input.summary);
	const omitted = input.filesTooLargeForPrompt;
	if (omitted && omitted.omitted > 0) {
		parts.push(filesTooLargeSentence(omitted.omitted, omitted.total));
	}
	if (input.latestChanges) {
		parts.push(`**Latest changes:** ${input.latestChanges}\n${LATEST_CHANGES_END}`);
	}

	if (input.staleHead) {
		parts.push(`> [!NOTE]\n> ${STALE_HEAD_NOTE_MARK} ${cell(input.staleHead)}`);
	}
	if (input.approvalWithheld) parts.push(`> [!NOTE]\n> ${cell(input.approvalWithheld)}`);

	if (input.posted.length) {
		parts.push(
			detailsSection(
				'Findings',
				input.posted.length,
				[
					'| | Finding | Where |',
					'| :-: | :- | :- |',
					...input.posted.map(
						(f) =>
							`| ${severityIcon[f.severity]} | ${cell(f.title)} | ${lineLink(f.path, f.startLine, f.endLine)} |`
					)
				].join('\n'),
				true
			)
		);
	}

	const unattached = input.dropped.filter((f) => isUnattachedDrop(f.dropReason));
	if (unattached.length) {
		parts.push(
			detailsSection(
				"Couldn't attach to a line",
				unattached.length,
				[
					'These findings could not be placed on a changed line, so they were not posted as inline comments.',
					'',
					...unattached.map(
						(f) =>
							`- ${cell(f.title)} · ${lineLink(f.path, f.startLine, f.endLine)} · ${cell(f.dropReason)}`
					)
				].join('\n'),
				true
			)
		);
	}

	const openIssues: AgentIssue[] = [
		...input.posted,
		...input.stillOpen.map((finding) => ({
			path: finding.path,
			startLine: finding.startLine,
			endLine: finding.endLine,
			title: finding.title,
			body: finding.body,
			...(finding.suggestion ? { suggestion: finding.suggestion } : {})
		}))
	];
	if (openIssues.length) {
		parts.push(agentPromptBlock('Fix with agent prompt', summaryAgentPrompt(openIssues)));
	}

	if (input.walkthrough.length) {
		parts.push(
			detailsSection(
				'Walkthrough',
				input.walkthrough.length,
				[
					'| File | Change |',
					'| :- | :- |',
					...input.walkthrough.map((w) => `| \`${cell(w.path)}\` | ${cell(w.change)} |`)
				].join('\n')
			)
		);
	}
	if (input.stillOpen.length) {
		parts.push(
			detailsSection(
				'Still open from earlier reviews',
				input.stillOpen.length,
				input.stillOpen
					.map((f) => `- ${severityIcon[f.severity]} ${f.title} · ${lineLink(f.path, f.startLine)}`)
					.join('\n')
			)
		);
	}
	if (input.resolved.length) {
		parts.push(
			detailsSection(
				'Fixed since the last review',
				input.resolved.length,
				input.resolved.map((f) => `- ~~${f.title}~~ · \`${f.path}:${f.startLine}\``).join('\n')
			)
		);
	}
	const filtered = input.dropped.filter((f) => !isUnattachedDrop(f.dropReason));
	if (filtered.length) {
		parts.push(
			detailsSection(
				'Filtered out',
				filtered.length,
				[
					'Findings Hansi considered but did not post.',
					'',
					'| Finding | Why |',
					'| :- | :- |',
					...filtered.map((f) => `| ${cell(f.title)} | ${cell(f.dropReason)} |`)
				].join('\n')
			)
		);
	}

	const reviewed = input.scope
		? input.scope
		: input.incrementalFrom
			? `Reviewed the commits since <code>${input.incrementalFrom.slice(0, 7)}</code>`
			: `Reviewed <code>${input.headSha.slice(0, 7)}</code>`;
	parts.push(`<br>\n\n<sub>${reviewed}</sub>`, interactionTip(input.mention));
	return parts.join('\n\n');
}

/** One sentence for the summary when some reviewable files did not fit in the prompt. */
export function filesTooLargeSentence(omitted: number, total: number): string {
	const verb = omitted === 1 ? 'was' : 'were';
	return `${omitted} of ${total} changed files ${verb} too large to include in full.`;
}

const filesTooLargeLine =
	/^(\d+) of (\d+) changed files (?:was|were) too large to include in full\.$/;

/** Reads the coverage sentence back out of a summary comment. Null when it is not there. */
export function filesTooLargeFromBody(body: string): { omitted: number; total: number } | null {
	for (const line of body.split('\n')) {
		const match = filesTooLargeLine.exec(line);
		const omitted = match?.[1];
		const total = match?.[2];
		if (omitted === undefined || total === undefined) continue;
		return { omitted: Number(omitted), total: Number(total) };
	}
	return null;
}

/** The body of the GitHub review itself; the summary comment carries the details. */
export function formatReviewBody(input: {
	tier: Tier;
	verdict: Verdict;
	blocking: number;
	/** Inline comments on this review. A Tier S review with none still says it is ready. */
	comments?: number;
	/** Findings listed in the review body because GitHub would not take them inline. */
	inBody?: number;
	summaryUrl?: string;
}): string {
	const link = input.summaryUrl ? ` [Summary](${input.summaryUrl})` : '';
	const inBody = input.inBody ?? 0;
	const readyWithoutComments = input.tier === 'S' && input.comments === 0 && inBody === 0;
	const headline =
		input.verdict === 'request_changes'
			? `${plural(input.blocking, 'blocking finding')} to address.`
			: input.verdict === 'approve' || readyWithoutComments
				? 'Looks good to merge.'
				: input.comments === 0 && inBody > 0
					? 'See the findings below.'
					: 'See the inline comments.';
	return `${tierIcon[input.tier]} **Tier ${input.tier}** · ${headline}${link}`;
}

/**
 * Findings GitHub would not take as inline comments, for the review body. GitHub does not show
 * a diff for every file of a large pull request, and comments there are rejected.
 */
export function formatBodyFindings(findings: Finding[], permalink: FilePermalink): string {
	if (findings.length === 0) return '';
	const intro =
		findings.length === 1
			? "GitHub does not show the diff for this finding's lines, so it is listed here instead of inline. To answer it, comment on the pull request and quote its title."
			: "GitHub does not show the diff for these findings' lines, so they are listed here instead of inline. To answer one, comment on the pull request and quote its title.";
	const items = findings.map((finding) => {
		const range =
			finding.startLine < finding.endLine
				? `${finding.startLine}-${finding.endLine}`
				: `${finding.endLine}`;
		return `#### \`${finding.path}:${range}\`\n\n${formatFindingComment(finding, permalink)}`;
	});
	return [`> [!NOTE]\n> ${intro}`, ...items].join('\n\n---\n\n');
}
