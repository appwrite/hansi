import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { git, GitError } from './git';

// Read-only tools over the pull request checkout. Nothing here runs code from the repository:
// commands go to the sandbox. Every file is written by the pull request author, so tool output
// is data for the model, never instructions.

export type Emit = (type: string, data?: Record<string, unknown>) => void;

const MAX_READ_LINES = 400;
const MAX_GREP_LINES = 100;
const MAX_LISTED_FILES = 300;
const MAX_HISTORY_COMMITS = 20;
const MAX_HISTORY_CHARS = 20_000;

function inside(root: string, absolute: string): boolean {
	const rel = relative(root, absolute);
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
	return rel !== '.git' && !rel.startsWith(`.git${sep}`);
}

/** Resolves a path the model passed. Throws for anything outside the checkout or inside `.git`. */
export function resolveRepoPath(repoDir: string, path: string): string {
	// Models often write repository paths with a leading slash.
	const absolute = resolve(repoDir, path.replace(/^\/+/, ''));
	if (!inside(repoDir, absolute)) throw new Error(`Path is outside the repository: ${path}`);
	// The pull request can add symlinks, so what the path points to must be inside too.
	let target: string;
	try {
		target = realpathSync(absolute);
	} catch {
		return absolute; // Missing: reading it fails on its own.
	}
	if (!inside(realpathSync(repoDir), target)) {
		throw new Error(`Path is outside the repository: ${path}`);
	}
	return absolute;
}

/** git's error for a path that is not in a commit. */
function isMissingPath(error: unknown): boolean {
	// "does not exist in", or "exists on disk, but not in" when the working tree has it.
	return error instanceof GitError && /does not exist|but not in/.test(error.stderr);
}

function numbered(lines: string[], first: number): string {
	return lines.map((line, i) => `${String(first + i).padStart(5)}  ${line}`).join('\n');
}

function failure(error: unknown): string {
	return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export interface RepoToolsOptions {
	emit?: Emit;
	/** Base commit of the pull request. Lets read_file show a file as it was before. */
	baseSha?: string;
	/** Installation token, for blobs a partial clone still has to download. */
	token?: string;
}

export function createRepoTools(repoDir: string, options: RepoToolsOptions = {}) {
	const emit: Emit = options.emit ?? (() => {});
	const gitOptions = { cwd: repoDir, token: options.token };

	const readBase = async (path: string) => {
		if (!options.baseSha) throw new Error('The base version is not available');
		const file = relative(repoDir, resolveRepoPath(repoDir, path));
		try {
			return await git(['show', `${options.baseSha}:${file}`], gitOptions);
		} catch (error) {
			if (isMissingPath(error)) {
				throw new Error(`${path} does not exist at the base: the pull request adds it`, {
					cause: error
				});
			}
			throw error;
		}
	};

	return {
		read_file: tool({
			description: `Read a file at the pull request head, with line numbers. At most ${MAX_READ_LINES} lines per call: use startLine and endLine for long files. Set ref to "base" to read the file as it was before the pull request.`,
			inputSchema: z.object({
				path: z.string(),
				startLine: z.number().int().positive().optional(),
				endLine: z.number().int().positive().optional(),
				ref: z.enum(['base']).optional()
			}),
			execute: async ({ path, startLine = 1, endLine, ref }) => {
				emit('tool.read_file', { path, startLine, endLine, ref });
				try {
					const content = ref
						? await readBase(path)
						: await readFile(resolveRepoPath(repoDir, path), 'utf8');
					const lines = content.split('\n');
					const last = Math.min(
						endLine ?? lines.length,
						startLine + MAX_READ_LINES - 1,
						lines.length
					);
					const more = last < lines.length ? `\n… ${lines.length - last} more lines` : '';
					const label = ref ? `${path} at base` : path;
					return `${label} (lines ${startLine}-${last} of ${lines.length})\n${numbered(lines.slice(startLine - 1, last), startLine)}${more}`;
				} catch (error) {
					return failure(error);
				}
			}
		}),

		grep: tool({
			description: 'Search the repository with ripgrep, e.g. for callers and definitions.',
			inputSchema: z.object({
				pattern: z.string().describe('A Rust regex, or a literal string with fixedStrings'),
				fixedStrings: z.boolean().optional(),
				glob: z.string().optional().describe('Only paths matching this glob, e.g. "src/**/*.ts"')
			}),
			execute: async ({ pattern, fixedStrings, glob }) => {
				emit('tool.grep', { pattern, glob });
				const args = ['rg', '--line-number', '--no-heading', '--color=never'];
				args.push('--max-columns=300', '--max-count=20', '--glob=!.git');
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
				const lines = stdout.trimEnd().split('\n');
				const more =
					lines.length > MAX_GREP_LINES ? `\n… ${lines.length - MAX_GREP_LINES} more matches` : '';
				return lines.slice(0, MAX_GREP_LINES).join('\n') + more;
			}
		}),

		list_files: tool({
			description: 'List the tracked files under a directory.',
			inputSchema: z.object({ path: z.string().default('.') }),
			execute: async ({ path }) => {
				emit('tool.list_files', { path });
				try {
					const dir = relative(repoDir, resolveRepoPath(repoDir, path)) || '.';
					const files = (await git(['ls-files', '--', dir], gitOptions))
						.split('\n')
						.filter(Boolean);
					if (!files.length) return 'No files.';
					const more =
						files.length > MAX_LISTED_FILES ? `\n… ${files.length - MAX_LISTED_FILES} more` : '';
					return files.slice(0, MAX_LISTED_FILES).join('\n') + more;
				} catch (error) {
					return failure(error);
				}
			}
		}),

		file_history: tool({
			description:
				'Recent commits that touched a file, newest first. Use it when a change looks deliberate but wrong, or undoes something: a recent revert or fix on the same lines is strong evidence. Set patches to see what each commit changed.',
			inputSchema: z.object({
				path: z.string(),
				limit: z.number().int().positive().max(MAX_HISTORY_COMMITS).default(10),
				patches: z.boolean().optional()
			}),
			execute: async ({ path, limit, patches }) => {
				emit('tool.file_history', { path, limit, patches: !!patches });
				try {
					const file = relative(repoDir, resolveRepoPath(repoDir, path));
					const args = [
						'log',
						'--no-color',
						`--max-count=${limit}`,
						'--format=%h %as %an: %s',
						'--follow'
					];
					if (patches) args.push('--patch', '--no-ext-diff');
					const log = await git([...args, '--', file], gitOptions);
					if (!log.trim()) return 'No commits touch this file.';
					return log.length > MAX_HISTORY_CHARS
						? `${log.slice(0, MAX_HISTORY_CHARS)}\n… cut; ask for fewer commits`
						: log.trimEnd();
				} catch (error) {
					return failure(error);
				}
			}
		})
	};
}

/** Files that carry a project's rules for agents and contributors, in the order they are read. */
export const GUIDELINE_FILES = [
	'AGENTS.md',
	'CLAUDE.md',
	'.cursorrules',
	'.github/copilot-instructions.md',
	'CONTRIBUTING.md'
] as const;

const MAX_GUIDELINE_CHARS = 200_000;

/**
 * The project's guideline files at `ref`, which should be the pull request's base: a pull
 * request must not rewrite the rules it is reviewed by. Each file is included whole up to a
 * generous cap, so a long file cannot push out the next one.
 */
export async function loadGuidelines(
	repoDir: string,
	ref: string,
	token?: string
): Promise<{ path: string; content: string }[]> {
	const found: { path: string; content: string }[] = [];
	for (const path of GUIDELINE_FILES) {
		// Only a missing file is skipped: a failed fetch must not drop the rules silently.
		const content = await git(['show', `${ref}:${path}`], { cwd: repoDir, token }).catch(
			(error: unknown) => {
				if (isMissingPath(error)) return null;
				throw error;
			}
		);
		if (!content?.trim() || content.includes('\0')) continue;
		found.push({
			path,
			content:
				content.length > MAX_GUIDELINE_CHARS
					? `${content.slice(0, MAX_GUIDELINE_CHARS)}\n… the rest of this file was not loaded`
					: content
		});
	}
	return found;
}
