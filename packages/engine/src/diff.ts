import parseDiff from 'parse-diff';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
	type: 'add' | 'del' | 'context';
	/** Line number in the new file; undefined for deletions. */
	newLine?: number;
	content: string;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	oldPath?: string;
	status: FileStatus;
	additions: number;
	deletions: number;
	binary: boolean;
	/** The diff was too large to load: the file is listed, but without its hunks. */
	omitted?: boolean;
	hunks: DiffHunk[];
}

/**
 * Ends the header of a file whose diff `gitDiff` left out for its size. `parse-diff` ignores the
 * line; `parseUnifiedDiff` marks the file `omitted`.
 */
export const OMITTED_DIFF_LINE = 'Hansi: diff too large to load';

/** Indexes, in diff order, of the files whose diff was left out. */
function omittedFiles(diff: string): Set<number> {
	const omitted = new Set<number>();
	if (!diff.includes(OMITTED_DIFF_LINE)) return omitted;
	let index = -1;
	for (const match of diff.matchAll(new RegExp(`^(?:diff --git |${OMITTED_DIFF_LINE}$)`, 'gm'))) {
		if (match[0].startsWith('diff --git ')) index++;
		else omitted.add(index);
	}
	return omitted;
}

/** Parses `git diff` output into per-file hunks with new-side line numbers. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
	const omitted = omittedFiles(diff);
	return parseDiff(diff).map((file, index) => {
		const path = file.deleted ? file.from! : file.to!;
		const renamed = !!file.from && !!file.to && file.from !== file.to && !file.new && !file.deleted;
		const status: FileStatus = file.new
			? 'added'
			: file.deleted
				? 'deleted'
				: renamed
					? 'renamed'
					: 'modified';

		const hunks = file.chunks.map((chunk) => ({
			header: chunk.content,
			lines: chunk.changes.map((change): DiffLine => {
				const content = change.content.slice(1);
				if (change.type === 'add') return { type: 'add', newLine: change.ln, content };
				if (change.type === 'del') return { type: 'del', content };
				return { type: 'context', newLine: change.ln2, content };
			})
		}));

		return {
			path,
			oldPath: renamed ? file.from : undefined,
			status,
			additions: file.additions,
			deletions: file.deletions,
			binary:
				file.chunks.length === 0 && !file.deleted && !file.new && !renamed && !omitted.has(index),
			...(omitted.has(index) ? { omitted: true } : {}),
			hunks
		};
	});
}

/**
 * Parses one file's `patch` from GitHub's pull request files API. It holds only the hunks, so the
 * file header is added back for the parser.
 */
export function parseGitHubPatch(path: string, patch: string): FileDiff | null {
	return parseUnifiedDiff(`--- a/${path}\n+++ b/${path}\n${patch}\n`)[0] ?? null;
}

/**
 * Splits a whole pull request's `git diff` into each file's patch as GitHub's files API gives it:
 * the hunks without the file header. For hosts that serve a pull request's diff in one piece.
 * A file with no hunks (binary, a pure rename, a mode change) has no `patch`.
 */
export function splitPatches(diff: string): { path: string; patch?: string }[] {
	const files: { path: string; patch?: string }[] = [];
	for (const section of diff.split(/^(?=diff --git )/m)) {
		if (!section.startsWith('diff --git ')) continue;
		const lines = section.replace(/\n$/, '').split('\n');
		const hunk = lines.findIndex((line) => line.startsWith('@@'));
		const header = hunk === -1 ? lines : lines.slice(0, hunk);
		const path = headerPath(header);
		if (!path) continue;
		files.push({ path, ...(hunk === -1 ? {} : { patch: lines.slice(hunk).join('\n') }) });
	}
	return files;
}

/** The file a diff section is about: the new path, or the old one for a deleted file. */
function headerPath(header: string[]): string | undefined {
	const value = (prefix: string) =>
		header.find((line) => line.startsWith(prefix))?.slice(prefix.length);
	const strip = (path: string) => path.replace(/^[ab]\//, '').replace(/\t.*$/, '');
	const to = value('+++ ');
	if (to && to !== '/dev/null') return strip(to);
	const from = value('--- ');
	if (from && from !== '/dev/null') return strip(from);
	const renamed = value('rename to ');
	if (renamed) return renamed;
	// `diff --git a/<path> b/<path>`, for a binary file or a mode change.
	const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header[0] ?? '');
	return match?.[2];
}

/** Lines GitHub accepts review comments on (RIGHT side): added and context lines in hunks. */
export function commentableLines(file: FileDiff): Set<number> {
	const lines = new Set<number>();
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			if (line.newLine !== undefined) lines.add(line.newLine);
		}
	}
	return lines;
}

/** Hunk index containing `line`, so multi-line comments never span hunks (GitHub rejects that). */
export function hunkIndexOf(file: FileDiff, line: number): number {
	return file.hunks.findIndex((hunk) => hunk.lines.some((l) => l.newLine === line));
}

/**
 * Renders a file diff for the model with explicit new-side line numbers, so the model can cite
 * lines that map directly onto GitHub's review comment API.
 */
export function renderFileDiff(file: FileDiff): string {
	const header = `### ${file.path}${file.oldPath ? ` (renamed from ${file.oldPath})` : ''} [${file.status}, +${file.additions} -${file.deletions}]`;
	const hunks = file.hunks.map((hunk) => {
		const lines = hunk.lines.map((line) => {
			const number = line.newLine === undefined ? '' : String(line.newLine);
			const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
			return `${number.padStart(5)} ${marker} ${line.content}`;
		});
		return [hunk.header, ...lines].join('\n');
	});
	if (file.omitted) hunks.push('(diff too large to show: read the file with the tools)');
	return [header, ...hunks].join('\n');
}

/**
 * The diff around new-file lines `start`..`end`, cut to `context` lines either side, so a reader
 * can see what the code did before. Null when no hunk touches the lines, or the file is new and
 * the diff would only repeat its contents.
 */
export function renderDiffExcerpt(
	file: FileDiff,
	start: number,
	end: number,
	context = 15
): string | null {
	if (file.status === 'added') return null;
	const inRange = (line: DiffLine) =>
		line.newLine !== undefined && line.newLine >= start && line.newLine <= end;
	const hunks = file.hunks.flatMap((hunk) => {
		const first = hunk.lines.findIndex(inRange);
		if (first === -1) return [];
		const last = hunk.lines.findLastIndex(inRange);
		const lines = hunk.lines.slice(Math.max(first - context, 0), last + context + 1);
		return [{ header: hunk.header, lines }];
	});
	return hunks.length ? renderFileDiff({ ...file, hunks }) : null;
}
