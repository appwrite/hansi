export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly exitCode: number,
		readonly stderr: string
	) {
		super(`git ${args[0]} failed (${exitCode}): ${stderr.trim().slice(0, 500)}`);
	}
}

interface GitOptions {
	cwd?: string;
	/** Installation token; sent as a header so it never lands in `.git/config` or logs. */
	token?: string;
	signal?: AbortSignal;
}

export async function git(args: string[], options: GitOptions = {}): Promise<string> {
	const auth = options.token
		? [
				'-c',
				`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`
			]
		: [];

	const proc = Bun.spawn(['git', ...auth, ...args], {
		cwd: options.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		signal: options.signal,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
	return stdout;
}

export interface CheckoutOptions {
	dir: string;
	cloneUrl: string;
	token?: string;
	pullNumber: number;
	baseSha: string;
	headSha: string;
	signal?: AbortSignal;
}

/**
 * Checks out a pull request's head and returns its diff against the merge base (what GitHub
 * shows in "Files changed"). Uses a blobless clone: full history for the merge base, but file
 * contents are only downloaded for the checked-out tree.
 */
export async function checkoutPullRequest(options: CheckoutOptions): Promise<string> {
	const { dir, token, signal } = options;
	await git(['init', '--quiet', dir], { signal });
	await git(['remote', 'add', 'origin', options.cloneUrl], { cwd: dir, signal });
	// `pull/N/head` also covers PRs from forks, whose head commit is not on any branch here.
	await git(
		[
			'fetch',
			'--quiet',
			'--no-tags',
			'--filter=blob:none',
			'origin',
			options.baseSha,
			`+refs/pull/${options.pullNumber}/head:refs/remotes/origin/pr`
		],
		{ cwd: dir, token, signal }
	);
	await git(['checkout', '--quiet', '--detach', options.headSha], { cwd: dir, token, signal });
	return git(
		[
			'diff',
			'--no-color',
			'--no-ext-diff',
			'--find-renames',
			`${options.baseSha}...${options.headSha}`
		],
		{ cwd: dir, token, signal }
	);
}

/**
 * Diff of the commits since `fromSha` (a previously reviewed head), or `null` when that commit
 * is gone or no longer an ancestor of `headSha`, e.g. after a force-push or rebase.
 */
export async function diffSince(options: {
	dir: string;
	fromSha: string;
	headSha: string;
	token?: string;
	signal?: AbortSignal;
}): Promise<string | null> {
	const { dir, fromSha, headSha, token, signal } = options;
	try {
		await git(['cat-file', '-e', `${fromSha}^{commit}`], { cwd: dir, signal }).catch(() =>
			git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', fromSha], {
				cwd: dir,
				token,
				signal
			})
		);
		await git(['merge-base', '--is-ancestor', fromSha, headSha], { cwd: dir, signal });
	} catch (error) {
		if (error instanceof GitError) return null;
		throw error;
	}
	return git(['diff', '--no-color', '--no-ext-diff', '--find-renames', `${fromSha}..${headSha}`], {
		cwd: dir,
		token,
		signal
	});
}

export type PullRequestDelta =
	{ status: 'fallback' } | { status: 'unchanged' } | { status: 'changed'; diff: string };

/**
 * The pull request's own changes between `lastHead` (the previously reviewed head) and `headSha`.
 *
 * Compares per-file `git patch-id --stable` of the old PR diff (`baseSha...lastHead`) and the new
 * one (`baseSha...headSha`). Three-dot diffs are against the merge base, so a merge of the base
 * branch does not count as the PR's work. Files whose patch is unchanged are dropped. For the
 * rest, only hunks of `lastHead..headSha` that also touch the new PR diff are kept: additions
 * match on `(path, newLine)`, and a pure deletion matches at the same head-side anchor. Both
 * diffs number lines on `headSha`.
 *
 * `unchanged` means no PR file changed (the merge-only path). `fallback` means the old head is
 * gone, is not an ancestor (a force-push), or git failed — review the whole pull request.
 */
export async function pullRequestDelta(options: {
	dir: string;
	baseSha: string;
	lastHead: string;
	headSha: string;
	token?: string;
	signal?: AbortSignal;
}): Promise<PullRequestDelta> {
	const { dir, baseSha, lastHead, headSha, token, signal } = options;
	try {
		const since = await diffSince({ dir, fromSha: lastHead, headSha, token, signal });
		if (since === null) return { status: 'fallback' };
		const range = (from: string, to: string) =>
			git(['diff', '--no-color', '--no-ext-diff', '--find-renames', `${from}...${to}`], {
				cwd: dir,
				token,
				signal
			});
		const [oldDiff, newDiff] = await Promise.all([
			range(baseSha, lastHead),
			range(baseSha, headSha)
		]);
		const diff = await keepPullRequestChanges(dir, oldDiff, newDiff, since, signal);
		if (!diff.includes('diff --git ')) return { status: 'unchanged' };
		return { status: 'changed', diff };
	} catch (error) {
		if (error instanceof GitError) return { status: 'fallback' };
		throw error;
	}
}

/** Second parent of a merge commit, or null when `sha` is not a merge. */
export async function mergeSecondParent(
	dir: string,
	sha: string,
	signal?: AbortSignal
): Promise<string | null> {
	try {
		const parent = (await git(['rev-parse', '--verify', `${sha}^2`], { cwd: dir, signal })).trim();
		return parent || null;
	} catch (error) {
		if (error instanceof GitError) return null;
		throw error;
	}
}

interface DiffHunkText {
	text: string;
	addedLines: number[];
	/** Head-side anchors of a hunk that only deletes. Empty when the hunk adds lines. */
	deletionAnchors: number[];
	/** Old-side numbers of the lines the hunk deletes. */
	deletedLines: number[];
}

interface DiffSection {
	path: string;
	oldPath?: string;
	header: string;
	hunks: DiffHunkText[];
	raw: string;
}

/** Drops base-branch changes from `sinceDiff`, leaving the pull request's own delta. */
async function keepPullRequestChanges(
	dir: string,
	oldDiff: string,
	newDiff: string,
	sinceDiff: string,
	signal?: AbortSignal
): Promise<string> {
	const oldByPath = indexSections(splitDiff(oldDiff));
	const newByPath = indexSections(splitDiff(newDiff));
	const kept: string[] = [];

	for (const section of splitDiff(sinceDiff)) {
		const previous = lookupSection(oldByPath, section);
		const current = lookupSection(newByPath, section);
		// Brought in by the base branch; not part of this pull request.
		if (!previous && !current) continue;
		// The pull request used to touch this file and no longer does.
		if (previous && !current) {
			kept.push(ensureTrailingNewline(section.raw));
			continue;
		}
		if (previous && current) {
			const [before, after] = await Promise.all([
				filePatchId(dir, previous.raw, signal),
				filePatchId(dir, current.raw, signal)
			]);
			if (before === after) continue;
		}
		if (!current) continue;
		// A rename or binary change has no line hunks to intersect; the patch id already said it changed.
		if (section.hunks.length === 0) {
			kept.push(ensureTrailingNewline(section.raw));
			continue;
		}
		const lines = pullRequestLines(current);
		const before = previous ? pullRequestLines(previous) : undefined;
		const hunks = section.hunks.filter(
			(hunk) =>
				hunkIntersects(hunk, lines) ||
				// Removing lines the pull request itself added leaves no trace in its new diff.
				(before !== undefined && hunk.deletedLines.some((line) => before.added.has(line)))
		);
		if (hunks.length === 0) continue;
		kept.push(section.header + hunks.map((hunk) => hunk.text).join(''));
	}
	return kept.join('');
}

function lookupSection(
	sections: Map<string, DiffSection>,
	section: DiffSection
): DiffSection | undefined {
	return (
		sections.get(section.path) ?? (section.oldPath ? sections.get(section.oldPath) : undefined)
	);
}

function indexSections(sections: DiffSection[]): Map<string, DiffSection> {
	return new Map(sections.map((section) => [section.path, section]));
}

interface PullRequestLines {
	added: Set<number>;
	deletionAnchors: Set<number>;
}

function pullRequestLines(section: DiffSection): PullRequestLines {
	const lines: PullRequestLines = { added: new Set(), deletionAnchors: new Set() };
	for (const hunk of section.hunks) {
		for (const line of hunk.addedLines) lines.added.add(line);
		for (const anchor of hunk.deletionAnchors) lines.deletionAnchors.add(anchor);
	}
	return lines;
}

function hunkIntersects(hunk: DiffHunkText, lines: PullRequestLines): boolean {
	if (hunk.addedLines.length > 0) return hunk.addedLines.some((line) => lines.added.has(line));
	return hunk.deletionAnchors.some((anchor) => lines.deletionAnchors.has(anchor));
}

function splitDiff(diff: string): DiffSection[] {
	if (!diff) return [];
	return diff
		.split(/^(?=diff --git )/m)
		.filter((part) => part.startsWith('diff --git '))
		.map(parseSection);
}

function parseSection(raw: string): DiffSection {
	const { path, oldPath } = sectionPaths(raw);
	const hunks: DiffHunkText[] = [];
	const matcher = /^@@ [^\n]*(?:\n(?!@@ |diff --git ).*)*/gm;
	let match: RegExpExecArray | null;
	let firstHunk = -1;
	while ((match = matcher.exec(raw))) {
		if (firstHunk === -1) firstHunk = match.index;
		hunks.push(parseHunk(ensureTrailingNewline(match[0])));
	}
	const header = firstHunk === -1 ? raw : raw.slice(0, firstHunk);
	return { path, oldPath, header, hunks, raw };
}

function parseHunk(text: string): DiffHunkText {
	const [header, ...body] = text.split('\n');
	const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header ?? '');
	let oldLine = start ? Number(/^@@ -(\d+)/.exec(header ?? '')?.[1] ?? 1) : 1;
	let newLine = start ? Number(start[1]) : 1;
	const addedLines: number[] = [];
	const deletionAnchors: number[] = [];
	const deletedLines: number[] = [];
	for (const line of body) {
		if (line.startsWith('+')) {
			addedLines.push(newLine);
			newLine++;
		} else if (line.startsWith('-')) {
			deletionAnchors.push(newLine);
			deletedLines.push(oldLine);
			oldLine++;
		} else if (line.startsWith(' ')) {
			newLine++;
			oldLine++;
		}
	}
	return {
		text,
		addedLines,
		deletedLines,
		// A modification is matched by its added line. Only a deletion has no new-side line.
		deletionAnchors: addedLines.length === 0 ? deletionAnchors : []
	};
}

function sectionPaths(raw: string): { path: string; oldPath?: string } {
	const renameFrom = /^rename from (.*)$/m.exec(raw);
	const renameTo = /^rename to (.*)$/m.exec(raw);
	if (renameTo) {
		const to = unquoteGitPath(renameTo[1] ?? '');
		const from = renameFrom ? unquoteGitPath(renameFrom[1] ?? '') : undefined;
		return from && from !== to ? { path: to, oldPath: from } : { path: to };
	}
	const plus = /^\+\+\+ (.*)$/m.exec(raw);
	const minus = /^--- (.*)$/m.exec(raw);
	const to = plus ? stripDiffPrefix(plus[1] ?? '') : undefined;
	const from = minus ? stripDiffPrefix(minus[1] ?? '') : undefined;
	if (to && to !== '/dev/null') {
		return from && from !== '/dev/null' && from !== to ? { path: to, oldPath: from } : { path: to };
	}
	if (from && from !== '/dev/null') return { path: from };
	const header = parseDiffGitLine(raw.split('\n')[0] ?? '');
	if (!header) return { path: 'unknown' };
	return header.a !== header.b ? { path: header.b, oldPath: header.a } : { path: header.b };
}

function parseDiffGitLine(line: string): { a: string; b: string } | null {
	const prefix = 'diff --git ';
	if (!line.startsWith(prefix)) return null;
	const rest = line.slice(prefix.length);
	const splitAt = rest.startsWith('"') ? quotedPathSplit(rest) : rest.indexOf(' b/');
	if (splitAt === null || splitAt < 0) return null;
	const a = stripDiffPrefix(rest.slice(0, splitAt));
	const b = stripDiffPrefix(rest.slice(splitAt + 1));
	if (!a || !b) return null;
	return { a, b };
}

/** Index of the separating space before `b/…` when both paths are quoted. */
function quotedPathSplit(rest: string): number | null {
	let i = 1;
	while (i < rest.length) {
		if (rest[i] === '\\') {
			i += 2;
			continue;
		}
		if (rest[i] === '"') return i + 1;
		i++;
	}
	return null;
}

function stripDiffPrefix(spec: string): string {
	const path = unquoteGitPath((spec.split('\t')[0] ?? spec).trim());
	if (path === '/dev/null') return path;
	return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function unquoteGitPath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	return value
		.slice(1, -1)
		.replace(/\\([\\"nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith('\n') ? text : `${text}\n`;
}

async function filePatchId(dir: string, patch: string, signal?: AbortSignal): Promise<string> {
	const proc = Bun.spawn(['git', 'patch-id', '--stable'], {
		cwd: dir,
		stdin: Buffer.from(patch),
		stdout: 'pipe',
		stderr: 'pipe',
		signal,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) throw new GitError(['patch-id', '--stable'], exitCode, stderr);
	const id = stdout.trim().split(/\s+/)[0];
	// Identical patches still compare equal when patch-id has nothing to hash (for example a mode-only diff).
	return id || `unhashed:${Bun.hash(patch).toString(16)}`;
}
