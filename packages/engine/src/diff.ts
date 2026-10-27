// Unified diffs, as `git diff` prints them and as GitHub's pull request files API returns them
// per file. Line numbers are new-file lines: those are what review comments are placed on.

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
	type: 'add' | 'del' | 'context';
	/** New-file line number. Deleted lines have none. */
	line?: number;
	text: string;
}

export interface Hunk {
	/** The `@@ … @@` line, including any section heading after it. */
	header: string;
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	/** Set for renames. */
	oldPath?: string;
	status: FileStatus;
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads the hunks starting at `lines[start]`. Hunk length comes from the header counts, not from
 * line prefixes: a removed line `-- comment` reads as `--- comment`, which looks like a file
 * header but is content.
 */
function readHunks(lines: string[], start: number): { hunks: Hunk[]; next: number } {
	const hunks: Hunk[] = [];
	let i = start;
	while (i < lines.length) {
		const header = lines[i]!;
		const match = HUNK_HEADER.exec(header);
		if (!match) break;
		let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
		let newLeft = match[4] === undefined ? 1 : Number(match[4]);
		let newLine = Number(match[3]);
		const hunk: Hunk = {
			header,
			oldStart: Number(match[1]),
			newStart: newLine,
			lines: []
		};
		i++;
		while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
			const raw = lines[i]!;
			const marker = raw[0];
			const text = raw.slice(1);
			if (marker === '+') {
				hunk.lines.push({ type: 'add', line: newLine++, text });
				newLeft--;
			} else if (marker === '-') {
				hunk.lines.push({ type: 'del', text });
				oldLeft--;
			} else if (marker === ' ' || raw === '') {
				// Some tools strip the space of an empty context line.
				hunk.lines.push({ type: 'context', line: newLine++, text });
				oldLeft--;
				newLeft--;
			} else if (marker !== '\\') {
				break;
			}
			i++;
		}
		// "\ No newline at end of file" may follow the last line.
		while (i < lines.length && lines[i]!.startsWith('\\')) i++;
		hunks.push(hunk);
	}
	return { hunks, next: i };
}

function counted(file: Omit<FileDiff, 'additions' | 'deletions'>): FileDiff {
	let additions = 0;
	let deletions = 0;
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			if (line.type === 'add') additions++;
			else if (line.type === 'del') deletions++;
		}
	}
	return { ...file, additions, deletions };
}

function stripPrefix(path: string): string | undefined {
	if (path === '/dev/null') return undefined;
	// `---`/`+++` lines may carry a tab and a timestamp after the path.
	const clean = path.split('\t')[0]!;
	return clean.startsWith('a/') || clean.startsWith('b/') ? clean.slice(2) : clean;
}

/**
 * Parses `git diff` output. Run git with `-c core.quotePath=false`: quoted paths are not
 * unescaped here.
 */
export function parseGitDiff(diff: string): FileDiff[] {
	const lines = diff.split('\n');
	const files: FileDiff[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = lines[i]!;
		if (!start.startsWith('diff --git ')) {
			i++;
			continue;
		}
		// Fallback for header-only entries (mode changes, binaries): `diff --git a/x b/x`.
		const halves = start.slice('diff --git '.length).split(' b/');
		let oldPath = stripPrefix(halves[0] ?? '');
		let newPath = halves.length === 2 ? halves[1] : oldPath;
		let status: FileStatus = 'modified';
		let binary = false;
		i++;

		while (
			i < lines.length &&
			!lines[i]!.startsWith('diff --git ') &&
			!HUNK_HEADER.test(lines[i]!)
		) {
			const line = lines[i]!;
			if (line.startsWith('new file mode')) status = 'added';
			else if (line.startsWith('deleted file mode')) status = 'deleted';
			else if (line.startsWith('rename from ')) oldPath = line.slice('rename from '.length);
			else if (line.startsWith('rename to ')) newPath = line.slice('rename to '.length);
			else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
			else if (line.startsWith('--- ')) oldPath = stripPrefix(line.slice(4)) ?? oldPath;
			else if (line.startsWith('+++ ')) newPath = stripPrefix(line.slice(4)) ?? newPath;
			i++;
		}

		const { hunks, next } = readHunks(lines, i);
		i = next;
		if (status === 'modified' && oldPath && newPath && oldPath !== newPath) status = 'renamed';
		const path = (status === 'deleted' ? oldPath : newPath) ?? oldPath ?? '';
		files.push(
			counted({
				path,
				oldPath: status === 'renamed' ? oldPath : undefined,
				status,
				binary,
				hunks
			})
		);
	}
	return files;
}

const githubStatus: Record<string, FileStatus> = {
	added: 'added',
	removed: 'deleted',
	renamed: 'renamed',
	modified: 'modified',
	changed: 'modified',
	copied: 'added',
	unchanged: 'modified'
};

/**
 * One file from GitHub's pull request files API. Its `patch` holds only hunks, and is missing
 * for binaries and for diffs GitHub considers too large.
 */
export function parseGitHubFile(file: {
	path: string;
	previousPath?: string;
	status: string;
	patch?: string;
}): FileDiff {
	const status = githubStatus[file.status] ?? 'modified';
	return counted({
		path: file.path,
		oldPath: status === 'renamed' ? file.previousPath : undefined,
		status,
		binary: file.patch === undefined,
		hunks: file.patch === undefined ? [] : readHunks(file.patch.split('\n'), 0).hunks
	});
}

/** New-file lines GitHub accepts review comments on: added and context lines in a hunk. */
export function commentableLines(file: FileDiff): Set<number> {
	const lines = new Set<number>();
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) if (line.line !== undefined) lines.add(line.line);
	}
	return lines;
}

/** The hunk holding a new-file line, or -1. A multi-line comment must stay inside one hunk. */
export function hunkOf(file: FileDiff, line: number): number {
	return file.hunks.findIndex((hunk) => hunk.lines.some((l) => l.line === line));
}

/**
 * A file's diff for the model, with each new-file line number printed in front, so the lines
 * it cites map straight onto review comments.
 */
export function renderFileDiff(file: FileDiff): string {
	const renamed = file.oldPath ? ` (renamed from ${file.oldPath})` : '';
	const header = `### ${file.path}${renamed} [${file.status}, +${file.additions} -${file.deletions}]`;
	const marker = { add: '+', del: '-', context: ' ' } as const;
	const body = file.hunks.map((hunk) =>
		[
			hunk.header,
			...hunk.lines.map(
				(line) => `${String(line.line ?? '').padStart(5)} ${marker[line.type]} ${line.text}`
			)
		].join('\n')
	);
	return [header, ...body].join('\n');
}

/**
 * The diff around new-file lines `start`..`end`, with `context` lines either side, to show what
 * the code did before. Null when no hunk touches those lines, or for a new file, where the
 * excerpt would only repeat the file.
 */
export function renderExcerpt(
	file: FileDiff,
	start: number,
	end: number,
	context = 15
): string | null {
	if (file.status === 'added') return null;
	const inRange = (line: DiffLine) =>
		line.line !== undefined && line.line >= start && line.line <= end;
	const hunks = file.hunks.flatMap((hunk) => {
		const first = hunk.lines.findIndex(inRange);
		if (first === -1) return [];
		const last = hunk.lines.findLastIndex(inRange);
		return [{ ...hunk, lines: hunk.lines.slice(Math.max(first - context, 0), last + context + 1) }];
	});
	return hunks.length ? renderFileDiff({ ...file, hunks }) : null;
}
