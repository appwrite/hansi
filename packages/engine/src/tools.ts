import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { git, GitError } from './git';
import { astLanguages, astSearch } from './structure';

export type ReviewEvent = { type: string; data?: Record<string, unknown> };
export type EmitEvent = (event: ReviewEvent) => void;

/** The last fetch queued in each checkout. */
const fetchQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `work` after every earlier call for the same checkout has finished. A fetch replaces
 * FETCH_HEAD and takes its lock, so agents working in parallel in one checkout take turns.
 */
export function oneFetchAtATime<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
	const result = (fetchQueues.get(repoDir) ?? Promise.resolve()).then(work);
	const settled = result.catch(() => {});
	fetchQueues.set(repoDir, settled);
	void settled.then(() => {
		if (fetchQueues.get(repoDir) === settled) fetchQueues.delete(repoDir);
	});
	return result;
}

const MAX_READ_LINES = 400;
const MAX_GREP_LINES = 100;
const MAX_LIST_ENTRIES = 300;
const MAX_HISTORY_COMMITS = 20;
const MAX_HISTORY_CHARS = 20_000;
const MAX_LISTED_REFS = 200;
const MAX_CHECKED_REFS = 20;
/** Branch or tag names as the model passes them: no options, no revision syntax. */
const REF_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Resolves a model-supplied path inside the checkout; rejects escapes and `.git`. */
export function resolveRepoPath(repoDir: string, path: string): string {
	const absolute = resolve(repoDir, path.replace(/^\/+/, ''));
	const rel = relative(repoDir, absolute);
	if (rel.startsWith('..') || isAbsolute(rel) || rel === '.git' || rel.startsWith('.git/')) {
		throw new Error(`Path is outside the repository: ${path}`);
	}
	return absolute;
}

/** `*` matches anything; everything else is literal. No pattern matches every ref. */
export function refMatcher(pattern: string | undefined): (name: string) => boolean {
	if (!pattern) return () => true;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	const regex = new RegExp(`^${escaped}$`);
	return (name) => regex.test(name);
}

/** Branches and tags from `git ls-remote --heads --tags`, without peeled `^{}` duplicates. */
export function parseRemoteRefs(output: string): { branches: string[]; tags: string[] } {
	const branches: string[] = [];
	const tags: string[] = [];
	for (const line of output.split('\n')) {
		const ref = line.split('\t')[1];
		if (!ref || ref.endsWith('^{}')) continue;
		if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
		else if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
	}
	return { branches, tags };
}

/** Head path → base path for the renames in `git diff --name-status -z` output. */
function parseRenames(output: string): Map<string, string> {
	const renames = new Map<string, string>();
	const fields = output.split('\0');
	for (let i = 0; i < fields.length;) {
		const status = fields[i] ?? '';
		if (status.startsWith('R')) {
			renames.set(fields[i + 2]!, fields[i + 1]!);
			i += 3;
		} else {
			i += 2;
		}
	}
	return renames;
}

/**
 * Read-only tools over the checked-out repository. No code is ever executed. The token lets git
 * download blobs a partial clone does not have yet, e.g. for patches in `file_history`. With a
 * `baseRef`, `read_file` can also show a file as it was before the pull request.
 */
export function createRepoTools(
	repoDir: string,
	emit: EmitEvent,
	options: { token?: string; baseRef?: string } = {}
) {
	// Where the pull request branched off: the base branch may have moved on since.
	let forkPoint: Promise<string> | undefined;
	// Files the pull request renamed: head path → base path.
	let renames: Promise<Map<string, string>> | undefined;
	const readSource = async (path: string, ref?: 'base') => {
		const absolute = resolveRepoPath(repoDir, path);
		if (!ref) return { content: await readFile(absolute, 'utf8'), label: path };
		const { baseRef, token } = options;
		if (!baseRef) throw new Error('The base version is not available here');
		forkPoint ??= git(['merge-base', baseRef, 'HEAD'], { cwd: repoDir, token })
			.then((sha) => sha.trim())
			.catch(() => baseRef);
		const commit = await forkPoint;
		renames ??= git(['diff', '--name-status', '--find-renames', '-z', commit, 'HEAD'], {
			cwd: repoDir,
			token
		})
			.then(parseRenames)
			.catch(() => new Map());
		const file = relative(repoDir, absolute);
		const basePath = (await renames).get(file) ?? file;
		const content = await git(['show', `${commit}:${basePath}`], { cwd: repoDir, token }).catch(
			(error) => {
				if (error instanceof GitError && /does not exist|but not in/.test(error.stderr)) {
					throw new Error(`${path} does not exist at the base; it is new in this pull request`);
				}
				throw error;
			}
		);
		const was = basePath === file ? '' : `, renamed from ${basePath}`;
		return { content, label: `${path} at base${was}` };
	};

	return {
		read_file: tool({
			description: `Read a file from the repository at the PR head, with line numbers. Returns at most ${MAX_READ_LINES} lines; use startLine/endLine for large files. Set ref to "base" to read the file as it was before the pull request, e.g. to compare old and new behavior.`,
			inputSchema: z.object({
				path: z.string(),
				startLine: z.number().int().positive().optional(),
				endLine: z.number().int().positive().optional(),
				ref: z
					.enum(['base'])
					.optional()
					.describe('"base" for the version before the pull request; omit for the PR head')
			}),
			execute: async ({ path, startLine = 1, endLine, ref }) => {
				emit({ type: 'tool.read_file', data: { path, startLine, endLine, ref } });
				try {
					const { content, label } = await readSource(path, ref);
					const lines = content.split('\n');
					const end = Math.min(
						endLine ?? lines.length,
						startLine + MAX_READ_LINES - 1,
						lines.length
					);
					const body = lines
						.slice(startLine - 1, end)
						.map((line, i) => `${String(startLine + i).padStart(5)}  ${line}`)
						.join('\n');
					const more = end < lines.length ? `\n… ${lines.length - end} more lines` : '';
					return `${label} (lines ${startLine}-${end} of ${lines.length})\n${body}${more}`;
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		}),

		grep: tool({
			description:
				'Search the repository with ripgrep. Use it to find callers, definitions, and similar code.',
			inputSchema: z.object({
				pattern: z.string().describe('Rust regex, or a literal string when fixedStrings is true'),
				fixedStrings: z.boolean().optional(),
				glob: z.string().optional().describe('Limit to matching paths, e.g. "src/**/*.ts"')
			}),
			execute: async ({ pattern, fixedStrings, glob }) => {
				emit({ type: 'tool.grep', data: { pattern, glob } });
				const args = ['rg', '--line-number', '--no-heading', '--color=never', '--max-columns=300'];
				args.push('--max-count=20', '--glob=!.git');
				if (fixedStrings) args.push('--fixed-strings');
				if (glob) args.push('--glob', glob);
				args.push('--regexp', pattern, '.');

				const proc = Bun.spawn(args, { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited
				]);
				if (exitCode === 1) return 'No matches.';
				if (exitCode !== 0) return `Error: ${stderr.trim()}`;
				const lines = stdout.trim().split('\n');
				const truncated =
					lines.length > MAX_GREP_LINES ? `\n… ${lines.length - MAX_GREP_LINES} more matches` : '';
				return lines.slice(0, MAX_GREP_LINES).join('\n') + truncated;
			}
		}),

		ast_search: tool({
			description: `Structural code search (ast-grep): match syntax instead of text. Use it to find call sites, definitions, and usages precisely. Patterns are code with metavariables: $NAME matches one node, $$$ matches any number. Examples: "fetch($$$)", "$OBJ.save($$$)", "function $F($$$) { $$$ }", "class $C extends Base { $$$ }", "def $F($$$): $$$" (python). Some snippets do not parse on their own (e.g. Go method calls): then pass a full snippet as context and the node kind to match as selector, e.g. context "func f() { $DB.Exec($$$) }" with selector "call_expression".`,
			inputSchema: z.object({
				pattern: z.string(),
				language: z.enum(astLanguages),
				path: z.string().default('.').describe('Directory or file to search'),
				context: z.string().optional().describe('Full snippet containing the pattern'),
				selector: z.string().optional().describe('Tree-sitter node kind to match within context')
			}),
			execute: async ({ pattern, language, path, context, selector }) => {
				emit({ type: 'tool.ast_search', data: { pattern, language, path } });
				try {
					const matches = await astSearch({
						repoDir,
						absolutePath: resolveRepoPath(repoDir, path),
						language,
						pattern,
						context: context && selector ? { snippet: context, selector } : undefined
					});
					if (matches.length === 0) return 'No matches.';
					return matches.map((m) => `${m.path}:${m.line}: ${m.text.split('\n')[0]}`).join('\n');
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		}),

		file_history: tool({
			description: `Recent commits that touched a file (at the PR head), newest first: sha, date, author, and subject. Use it to see why code is the way it is, e.g. a recent revert or bug fix that the change might undo. Set patches to also see what each commit changed.`,
			inputSchema: z.object({
				path: z.string(),
				limit: z.number().int().positive().max(MAX_HISTORY_COMMITS).default(10),
				patches: z.boolean().optional().describe('Include the diff of each commit for this file')
			}),
			execute: async ({ path, limit, patches }) => {
				emit({ type: 'tool.file_history', data: { path, limit, patches: !!patches } });
				try {
					resolveRepoPath(repoDir, path);
					const args = ['log', '--no-color', `--max-count=${limit}`];
					args.push('--format=%h %as %an: %s', '--follow');
					if (patches) args.push('--patch', '--no-ext-diff');
					const log = await git([...args, '--', path], { cwd: repoDir, token: options.token });
					if (!log.trim()) return 'No commits touch this file.';
					return log.length > MAX_HISTORY_CHARS
						? `${log.slice(0, MAX_HISTORY_CHARS)}\n… truncated; ask for fewer commits`
						: log.trimEnd();
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		}),

		list_refs: tool({
			description: `List the repository's branches and tags on GitHub, e.g. release branches and version tags. Use it with path_in_refs to check claims about what was released or deployed, such as "no release contains this code". Pattern is a name glob where * matches anything, e.g. "2.*" or "cl-*".`,
			inputSchema: z.object({ pattern: z.string().optional() }),
			execute: async ({ pattern }) => {
				emit({ type: 'tool.list_refs', data: { pattern } });
				try {
					const output = await git(['ls-remote', '--heads', '--tags', 'origin'], {
						cwd: repoDir,
						token: options.token
					});
					const matches = refMatcher(pattern);
					const { branches, tags } = parseRemoteRefs(output);
					const list = (label: string, names: string[]) => {
						const found = names.filter(matches).sort();
						if (!found.length) return `${label}: none`;
						const more =
							found.length > MAX_LISTED_REFS
								? `\n… ${found.length - MAX_LISTED_REFS} more; narrow the pattern`
								: '';
						return `${label} (${found.length}):\n${found.slice(0, MAX_LISTED_REFS).join('\n')}${more}`;
					};
					return `${list('Branches', branches)}\n\n${list('Tags', tags)}`;
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		}),

		path_in_refs: tool({
			description: `Check whether a file or directory exists on other branches or tags (from list_refs), e.g. whether code in this pull request was ever on a release branch or in a release tag. Answers per ref: present or absent.`,
			inputSchema: z.object({
				path: z.string(),
				refs: z.array(z.string()).min(1).max(MAX_CHECKED_REFS)
			}),
			execute: async ({ path, refs }) => {
				emit({ type: 'tool.path_in_refs', data: { path, refs: refs.length } });
				try {
					const file = relative(repoDir, resolveRepoPath(repoDir, path));
					const lines: string[] = [];
					for (const ref of refs) {
						if (!REF_NAME.test(ref)) {
							lines.push(`${ref}: not a branch or tag name`);
							continue;
						}
						const listed = await oneFetchAtATime(repoDir, async () => {
							// Trees only: whether a path exists needs no file contents. No depth limit, so
							// history the checkout already has is not cut off.
							const fetched = await git(
								['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', ref],
								{ cwd: repoDir, token: options.token }
							).then(
								() => true,
								() => false
							);
							if (!fetched) return null;
							return git(['ls-tree', '--name-only', 'FETCH_HEAD', '--', file], { cwd: repoDir });
						});
						if (listed === null) {
							lines.push(`${ref}: no such branch or tag`);
							continue;
						}
						const present = listed.trim() !== '';
						lines.push(`${ref}: ${present ? 'present' : 'absent'}`);
					}
					return `${file}\n${lines.join('\n')}`;
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		}),

		list_files: tool({
			description: 'List tracked files under a directory.',
			inputSchema: z.object({ path: z.string().default('.') }),
			execute: async ({ path }) => {
				emit({ type: 'tool.list_files', data: { path } });
				try {
					resolveRepoPath(repoDir, path);
					const files = (await git(['ls-files', '--', path], { cwd: repoDir }))
						.split('\n')
						.filter(Boolean);
					const more =
						files.length > MAX_LIST_ENTRIES ? `\n… ${files.length - MAX_LIST_ENTRIES} more` : '';
					return files.slice(0, MAX_LIST_ENTRIES).join('\n') + more || 'No files.';
				} catch (error) {
					return `Error: ${(error as Error).message}`;
				}
			}
		})
	};
}

export const GUIDELINE_FILES = [
	'AGENTS.md',
	'CLAUDE.md',
	'.cursorrules',
	'.github/copilot-instructions.md',
	'CONTRIBUTING.md'
] as const;

/** Guideline files this diff adds, edits, deletes, or renames, in `GUIDELINE_FILES` order. */
export function changedGuidelineFiles(files: { path: string; oldPath?: string }[]): string[] {
	const present = new Set<string>();
	for (const file of files) {
		present.add(file.path);
		if (file.oldPath) present.add(file.oldPath);
	}
	return GUIDELINE_FILES.filter((path) => present.has(path));
}
/**
 * Per file, and every file is loaded. Authors do not place their rules to survive a cut,
 * so a long AGENTS.md must not drop its own middle or crowd out CLAUDE.md.
 */
const MAX_GUIDELINE_FILE_CHARS = 200_000;

export interface TrustedSource {
	/** Commit to read from, typically the PR's base: a PR must not rewrite its own review rules. */
	ref: string;
	/** Installation token, for blobs a partial clone still has to download. */
	token?: string;
}

interface GuidelineSection {
	path: string;
	content: string;
}

function renderGuidelines(sections: GuidelineSection[]): string {
	return sections
		.map((section) => {
			const content =
				section.content.length <= MAX_GUIDELINE_FILE_CHARS
					? section.content
					: `${section.content.slice(0, MAX_GUIDELINE_FILE_CHARS)}\n… rest of this file was not loaded\n`;
			return `<file path="${section.path}">\n${content}\n</file>`;
		})
		.join('\n\n');
}

/**
 * Project conventions the review should respect, from the files agents already use. Every file
 * that exists is included, in full. With a `trusted` source they come from that commit instead
 * of the (untrusted) PR checkout.
 */
export async function loadRepoGuidelines(
	repoDir: string,
	trusted?: TrustedSource
): Promise<string> {
	const read = (file: string) =>
		trusted
			? git(['show', `${trusted.ref}:${file}`], { cwd: repoDir, token: trusted.token })
			: readFile(resolve(repoDir, file), 'utf8');

	const sections: GuidelineSection[] = [];
	for (const file of GUIDELINE_FILES) {
		const content = await read(file).catch(() => null);
		if (!content?.trim() || content.includes('\0')) continue;
		sections.push({ path: file, content });
	}
	return renderGuidelines(sections);
}
