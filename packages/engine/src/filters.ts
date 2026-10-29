import type { FileDiff } from './diff';

/**
 * Dependency lockfiles. Reading one tells a model little, so they are ignored by default. With a
 * sandbox the reviewer can install the locked versions and run the build and tests, so they are
 * reviewed then.
 */
export const lockfileGlobs = [
	'**/*.lock',
	'**/package-lock.json',
	'**/npm-shrinkwrap.json',
	'**/pnpm-lock.yaml',
	'**/yarn.lock',
	'**/bun.lock',
	'**/bun.lockb',
	'**/Cargo.lock',
	'**/go.sum',
	'**/poetry.lock',
	'**/uv.lock',
	'**/composer.lock',
	'**/Gemfile.lock'
];

const lockfileMatchers = lockfileGlobs.map((g) => new Bun.Glob(g));

export function isLockfile(path: string): boolean {
	return lockfileMatchers.some((glob) => glob.match(path));
}

/**
 * Test snapshots and generated code. Read alone they say nothing about correctness, but with a
 * sandbox the reviewer can run the snapshot tests or the generator and compare the output.
 */
export const outputGlobs = ['**/*.snap', '**/*.generated.*', '**/*.pb.go'];

/** Ignored by default, but reviewed when a sandbox can check them by running something. */
export const sandboxCheckedGlobs = [...lockfileGlobs, ...outputGlobs];

const outputMatchers = outputGlobs.map((g) => new Bun.Glob(g));

export function isGeneratedOutput(path: string): boolean {
	return outputMatchers.some((glob) => glob.match(path));
}

/**
 * Files that are almost never worth an LLM's attention. Build output, vendored code, minified
 * bundles, and media stay ignored even with a sandbox: there is nothing to run that checks them
 * which the review of their sources does not already cover.
 */
export const defaultIgnoreGlobs = [
	...sandboxCheckedGlobs,
	'**/*.min.js',
	'**/*.min.css',
	'**/*.map',
	'**/dist/**',
	'**/build/**',
	'**/vendor/**',
	'**/node_modules/**',
	'**/*.svg',
	'**/*.png',
	'**/*.jpg',
	'**/*.gif',
	'**/*.ico',
	'**/*.pdf',
	'**/*.woff',
	'**/*.woff2'
];

export interface FilterResult {
	included: FileDiff[];
	excluded: { path: string; reason: string }[];
}

/**
 * Applies default ignores plus `.hansi.json` path filters. Filters without `!` are an allowlist;
 * filters with `!` exclude. User filters can re-include a default-ignored path. `sandbox` keeps
 * the files only a sandbox can check (lockfiles, snapshots, generated code) in the review.
 */
export function filterFiles(
	files: FileDiff[],
	pathFilters: string[] = [],
	options: { sandbox?: boolean } = {}
): FilterResult {
	const includes = pathFilters.filter((f) => !f.startsWith('!')).map((f) => new Bun.Glob(f));
	const excludes = pathFilters
		.filter((f) => f.startsWith('!'))
		.map((f) => new Bun.Glob(f.slice(1)));
	const ignored = options.sandbox
		? defaultIgnoreGlobs.filter((g) => !sandboxCheckedGlobs.includes(g))
		: defaultIgnoreGlobs;
	const defaults = ignored.map((g) => new Bun.Glob(g));

	const result: FilterResult = { included: [], excluded: [] };
	for (const file of files) {
		const reason = exclusionReason(file);
		if (reason) {
			result.excluded.push({ path: file.path, reason });
		} else if (excludes.some((glob) => glob.match(file.path))) {
			result.excluded.push({ path: file.path, reason: 'path filter' });
		} else if (includes.length > 0) {
			if (includes.some((glob) => glob.match(file.path))) result.included.push(file);
			else result.excluded.push({ path: file.path, reason: 'not in path filters' });
		} else if (defaults.some((glob) => glob.match(file.path))) {
			result.excluded.push({ path: file.path, reason: 'ignored by default' });
		} else {
			result.included.push(file);
		}
	}
	return result;

	function exclusionReason(file: FileDiff) {
		if (file.status === 'deleted') return 'deleted';
		if (file.binary) return 'binary';
		if (file.hunks.length === 0) return 'no content changes';
		return null;
	}
}
