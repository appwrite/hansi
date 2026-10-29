import { readFile } from 'node:fs/promises';
import type { Finding } from './findings';
import { countSyntaxErrors, languageForPath } from './structure';
import { resolveRepoPath } from './tools';

export type SuggestionCheck = { ok: true } | { ok: false; reason: string };

/**
 * A GitHub suggestion replaces lines startLine..endLine verbatim when applied. Apply it to the
 * real file and reject it if it changes nothing or introduces syntax errors (e.g. prose instead
 * of code, or a block that no longer closes).
 */
export async function checkSuggestion(repoDir: string, finding: Finding): Promise<SuggestionCheck> {
	if (finding.suggestion === undefined) return { ok: true };

	let original: string;
	try {
		original = await readFile(resolveRepoPath(repoDir, finding.path), 'utf8');
	} catch {
		return { ok: false, reason: 'file not readable' };
	}
	const lines = original.split('\n');
	const replaced = lines.slice(finding.startLine - 1, finding.endLine).join('\n');
	const suggestion = finding.suggestion.replace(/\n$/, '');
	if (suggestion.trim() === replaced.trim())
		return { ok: false, reason: 'suggestion changes nothing' };

	const language = languageForPath(finding.path);
	if (!language) return { ok: true };
	const applied = [
		...lines.slice(0, finding.startLine - 1),
		...suggestion.split('\n'),
		...lines.slice(finding.endLine)
	].join('\n');
	const before = countSyntaxErrors(language, original);
	const after = countSyntaxErrors(language, applied);
	return after > before
		? { ok: false, reason: `applying it introduces ${after - before} syntax error(s)` }
		: { ok: true };
}
