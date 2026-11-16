import { OMITTED_DIFF_LINE } from './diff';

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

function spawnGit(args: string[], options: GitOptions) {
	const auth = options.token
		? [
				'-c',
				`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`
			]
		: [];
	return Bun.spawn(['git', ...auth, ...args], {
		cwd: options.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		signal: options.signal,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
	});
}

export async function git(args: string[], options: GitOptions = {}): Promise<string> {
	const proc = spawnGit(args, options);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
	return stdout;
}

/**
 * A file whose diff is longer than this is kept as its header and an {@link OMITTED_DIFF_LINE}.
 * The review prompt shows at most 150,000 characters of diff, so a file this large is never shown
 * in full anyway; past it, holding the text only costs memory.
 */
export const MAX_FILE_DIFF_CHARS = 2_000_000;
/**
 * Diff text kept per diff, across files. Files that would go past it keep only their header. A
 * parsed diff takes several times its text in memory, and a review holds a few at once, so this
 * bounds what one job can use however large the pull request is.
 */
export const MAX_DIFF_CHARS = 8_000_000;

export interface DiffLimits {
	maxFileChars?: number;
	maxChars?: number;
}

/**
 * Runs `git diff` and keeps at most `maxChars` of its output, reading it as it streams. A file
 * whose diff is longer than `maxFileChars`, or that no longer fits, keeps its header (paths,
 * modes, index) followed by {@link OMITTED_DIFF_LINE}, so it is still listed as changed. A pull
 * request that commits recorded test fixtures can have a diff of a gigabyte: collected whole and
 * parsed, it took about 10 GB.
 */
export async function gitDiff(
	args: string[],
	options: GitOptions & DiffLimits = {}
): Promise<string> {
	const proc = spawnGit(args, options);
	const limiter = new DiffLimiter(options);
	const read = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) limiter.push(decoder.decode(chunk, { stream: true }));
		limiter.push(decoder.decode());
	})();
	const [, stderr, exitCode] = await Promise.all([
		read,
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
	return limiter.finish();
}

const FILE_START = 'diff --git ';
/** Header lines of a file section longer than this are cut, e.g. a path of megabytes. */
const MAX_HEADER_CHARS = 4_096;
/** A line start shorter than this is held until more arrives, to tell `diff --git ` apart. */
const LINE_START_CHARS = 16;

/** Applies `gitDiff`'s limits to diff text that arrives in pieces. */
export function limitDiff(pieces: Iterable<string>, limits: DiffLimits = {}): string {
	const limiter = new DiffLimiter(limits);
	for (const piece of pieces) limiter.push(piece);
	return limiter.finish();
}

/** Keeps a streamed `git diff` within its limits, one file section at a time. */
class DiffLimiter {
	private readonly maxFileChars: number;
	private readonly maxChars: number;
	private readonly kept: string[] = [];
	private keptChars = 0;
	/** The current file's header: from `diff --git ` to its first hunk. */
	private header: string[] = [];
	private headerChars = 0;
	private inHeader = false;
	/** The current file's hunks, while they are kept. */
	private body: string[] = [];
	private bodyChars = 0;
	private omitted = false;
	private atLineStart = true;
	/** A line start too short to classify yet, or the end of an omitted file. */
	private carry = '';

	constructor(limits: DiffLimits = {}) {
		this.maxFileChars = limits.maxFileChars ?? MAX_FILE_DIFF_CHARS;
		this.maxChars = limits.maxChars ?? MAX_DIFF_CHARS;
	}

	push(text: string): void {
		let rest = this.carry + text;
		this.carry = '';
		while (rest.length > 0) {
			if (this.omitted && !this.inHeader) {
				// Skip to the next file without splitting lines: an omitted file can be a gigabyte.
				const atStart = this.atLineStart && rest.startsWith(FILE_START);
				const newline = atStart ? -1 : rest.indexOf(`\n${FILE_START}`);
				if (!atStart && newline === -1) {
					// Keep the end, which may be the first part of the next file's header.
					this.carry = rest.slice(-FILE_START.length);
					this.atLineStart = false;
					return;
				}
				rest = rest.slice(atStart ? 0 : newline + 1);
				this.atLineStart = true;
			}
			const newline = rest.indexOf('\n');
			if (newline === -1 && this.atLineStart && rest.length < LINE_START_CHARS) {
				this.carry = rest;
				return;
			}
			const piece = newline === -1 ? rest : rest.slice(0, newline + 1);
			rest = newline === -1 ? '' : rest.slice(newline + 1);
			this.line(piece, this.atLineStart);
			this.atLineStart = newline !== -1;
		}
	}

	finish(): string {
		if (this.carry && !(this.omitted && !this.inHeader)) this.line(this.carry, this.atLineStart);
		this.carry = '';
		this.endFile();
		return this.kept.join('');
	}

	/** A whole line, or part of one; `start` when it begins a line. */
	private line(piece: string, start: boolean): void {
		if (start && piece.startsWith(FILE_START)) {
			this.endFile();
			this.inHeader = true;
		}
		if (start && piece.startsWith('@@')) this.inHeader = false;
		if (this.inHeader) {
			this.header.push(piece);
			this.headerChars += piece.length;
			// Only a path of kilobytes makes a header this long. Cut it, and the file with it.
			if (this.headerChars > MAX_HEADER_CHARS) {
				this.header = [`${this.header.join('').slice(0, MAX_HEADER_CHARS)}\n`];
				this.inHeader = false;
				this.omit();
			}
		} else if (!this.omitted) {
			this.body.push(piece);
			this.bodyChars += piece.length;
		}
		const size = this.headerChars + this.bodyChars;
		if (!this.omitted && (size > this.maxFileChars || this.keptChars + size > this.maxChars)) {
			this.omit();
		}
	}

	private omit(): void {
		this.omitted = true;
		this.body = [];
		this.bodyChars = 0;
	}

	private endFile(): void {
		if (this.omitted) {
			const header = this.header.join('');
			const stub = `${header}${header.endsWith('\n') || !header ? '' : '\n'}${OMITTED_DIFF_LINE}\n`;
			this.kept.push(stub);
			this.keptChars += stub.length;
		} else {
			this.kept.push(...this.header, ...this.body);
			this.keptChars += this.headerChars + this.bodyChars;
		}
		this.header = [];
		this.headerChars = 0;
		this.inHeader = false;
		this.body = [];
		this.bodyChars = 0;
		this.omitted = false;
	}
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
	return gitDiff(
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
	return gitDiff(
		['diff', '--no-color', '--no-ext-diff', '--find-renames', `${fromSha}..${headSha}`],
		{
			cwd: dir,
			token,
			signal
		}
	);
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
 *
 * A file whose PR diff was too large to load has no lines to match, so its changes since the last
 * review are kept whole.
 */
export async function pullRequestDelta(options: {
	dir: string;
	baseSha: string;
	lastHead: string;
	headSha: string;
	token?: string;
	signal?: AbortSignal;
	/** For the two PR diffs; `gitDiff`'s defaults otherwise. */
	limits?: DiffLimits;
}): Promise<PullRequestDelta> {
	const { dir, baseSha, lastHead, headSha, token, signal, limits } = options;
	try {
		const since = await diffSince({ dir, fromSha: lastHead, headSha, token, signal });
		if (since === null) return { status: 'fallback' };
		const range = (from: string, to: string) =>
			gitDiff(['diff', '--no-color', '--no-ext-diff', '--find-renames', `${from}...${to}`], {
				...limits,
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
		// Too large to load: there are no lines to match the change against, so keep all of it, unless
		// the file's PR diff is the same as before (its index line names both blobs). Its patch id
		// would only hash the header.
		if (current && current.raw.includes(`\n${OMITTED_DIFF_LINE}\n`)) {
			if (previous?.raw !== current.raw) kept.push(ensureTrailingNewline(section.raw));
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
