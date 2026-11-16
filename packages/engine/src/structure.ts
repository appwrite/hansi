// Structural code search with ast-grep: match syntax, not text, e.g. every call of `fetch($$$)`.
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import c from '@ast-grep/lang-c';
import cpp from '@ast-grep/lang-cpp';
import csharp from '@ast-grep/lang-csharp';
import go from '@ast-grep/lang-go';
import java from '@ast-grep/lang-java';
import kotlin from '@ast-grep/lang-kotlin';
import php from '@ast-grep/lang-php';
import python from '@ast-grep/lang-python';
import ruby from '@ast-grep/lang-ruby';
import rust from '@ast-grep/lang-rust';
import swift from '@ast-grep/lang-swift';
import { findInFiles, parse, registerDynamicLanguage } from '@ast-grep/napi';

const builtIn = ['TypeScript', 'Tsx', 'JavaScript', 'Html', 'Css'] as const;
const dynamic = { python, go, rust, java, kotlin, ruby, php, csharp, c, cpp, swift };

export const astLanguages = [...builtIn, ...(Object.keys(dynamic) as (keyof typeof dynamic)[])];
export type AstLanguage = (typeof astLanguages)[number];

let registered = false;

/** ast-grep allows registering dynamic languages once per process. */
function ensureLanguages() {
	if (registered) return;
	registered = true;
	registerDynamicLanguage(dynamic);
}

/**
 * Files handed to ast-grep at a time. ast-grep turns every match into a node object before the
 * callback can stop it, so one search over a whole repository with a pattern that matches almost
 * everything (`$A`) held millions of nodes at once: about 3 GB on appwrite-labs/cloud, enough to
 * get a worker with concurrent jobs OOM killed. Searching in batches lets a search stop once it
 * has its matches and caps what one batch can hold.
 */
const FILES_PER_BATCH = 200;

export interface AstMatch {
	path: string;
	line: number;
	text: string;
}

/**
 * Finds code matching an ast-grep pattern under `absolutePath`. Paths in the result are relative
 * to `repoDir`. Stops collecting after `limit` matches.
 */
export async function astSearch(options: {
	repoDir: string;
	absolutePath: string;
	language: AstLanguage;
	pattern: string;
	/**
	 * For snippets that don't parse on their own: a full snippet containing the pattern, plus the
	 * node kind to match, e.g. context `func f() { db.Exec($$$) }` with selector `call_expression`.
	 */
	context?: { snippet: string; selector: string };
	limit?: number;
}): Promise<AstMatch[]> {
	ensureLanguages();
	const limit = options.limit ?? 50;
	const matches: AstMatch[] = [];
	let failure: Error | null = null;
	const files = (await sourceFiles(options.repoDir, options.absolutePath)).filter(
		(file) => languageForPath(file) === options.language
	);

	for (let start = 0; start < files.length && matches.length < limit; start += FILES_PER_BATCH) {
		await findInFiles(
			options.language,
			{
				paths: files.slice(start, start + FILES_PER_BATCH),
				matcher: {
					rule: {
						pattern: options.context
							? { context: options.context.snippet, selector: options.context.selector }
							: options.pattern
					}
				}
			},
			(error, nodes) => {
				if (error) {
					failure = error;
					return;
				}
				for (const node of nodes) {
					if (matches.length >= limit) return;
					const text = node.text();
					matches.push({
						path: relative(options.repoDir, node.getRoot().filename()),
						line: node.range().start.line + 1,
						text: text.length > 200 ? `${text.slice(0, 200)}…` : text
					});
				}
			}
		);
		if (failure) throw failure;
	}
	return matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * Files under `absolutePath`, sorted: the tracked files when `repoDir` is a git checkout, which
 * leaves out what .gitignore ignores, as ast-grep's own walk did. Otherwise every file but `.git`.
 */
async function sourceFiles(repoDir: string, absolutePath: string): Promise<string[]> {
	const proc = Bun.spawn(['git', 'ls-files', '-z', '--', relative(repoDir, absolutePath) || '.'], {
		cwd: repoDir,
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const [listed, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode === 0) {
		return listed
			.split('\0')
			.filter(Boolean)
			.map((file) => join(repoDir, file))
			.sort();
	}
	const entries = await readdir(absolutePath, { recursive: true, withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			// A file path: search just that file.
			if (error.code === 'ENOTDIR') return null;
			throw error;
		}
	);
	if (entries === null) return [absolutePath];
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((file) => !relative(repoDir, file).split('/').includes('.git'))
		.sort();
}

const builtInExtensions: Record<string, AstLanguage> = {
	ts: 'TypeScript',
	mts: 'TypeScript',
	cts: 'TypeScript',
	tsx: 'Tsx',
	js: 'JavaScript',
	mjs: 'JavaScript',
	cjs: 'JavaScript',
	jsx: 'JavaScript',
	html: 'Html',
	css: 'Css'
};

/** The ast-grep language for a file path, or null when none is available. */
export function languageForPath(path: string): AstLanguage | null {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	if (builtInExtensions[extension]) return builtInExtensions[extension];
	for (const [name, language] of Object.entries(dynamic)) {
		if (language.extensions.includes(extension)) return name as AstLanguage;
	}
	return null;
}

/** Number of syntax errors tree-sitter finds in `source`. */
export function countSyntaxErrors(language: AstLanguage, source: string): number {
	ensureLanguages();
	return parse(language, source)
		.root()
		.findAll({ rule: { kind: 'ERROR' } }).length;
}
