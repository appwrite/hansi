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
	hunks: DiffHunk[];
}

/** Parses `git diff` output into per-file hunks with new-side line numbers. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
	return parseDiff(diff).map((file) => {
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
			binary: file.chunks.length === 0 && !file.deleted && !file.new && !renamed,
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
