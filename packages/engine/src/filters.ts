import type { FileDiff } from './diff';

// Which changed files the reviewer reads. Some files tell a reader nothing but can be checked by
// running something (installing locked versions, re-running a generator); those are reviewed
// only when a sandbox is available.

export const lockfiles = [
	'**/*.lock',
	'**/package-lock.json',
	'**/npm-shrinkwrap.json',
	'**/pnpm-lock.yaml',
	'**/bun.lockb',
	'**/go.sum'
];

export const generated = ['**/*.snap', '**/*.generated.*', '**/*.pb.go'];

/** Never worth reading, sandbox or not: build output, vendored code, bundles, media. */
export const noise = [
	'**/*.min.js',
	'**/*.min.css',
	'**/*.map',
	'**/dist/**',
	'**/build/**',
	'**/vendor/**',
	'**/node_modules/**',
	'**/*.{svg,png,jpg,jpeg,gif,webp,ico,pdf,woff,woff2,ttf}'
];

export interface Excluded {
	path: string;
	reason: 'deleted' | 'binary' | 'no changes' | 'excluded by paths' | 'not in paths' | 'ignored';
}

export interface FilterResult {
	included: FileDiff[];
	excluded: Excluded[];
}

const globs = (patterns: string[]) => patterns.map((pattern) => new Bun.Glob(pattern));
const matches = (patterns: Bun.Glob[], path: string) => patterns.some((glob) => glob.match(path));

const lockfileGlobs = globs(lockfiles);
const generatedGlobs = globs(generated);
const noiseGlobs = globs(noise);

export function isLockfile(path: string): boolean {
	return matches(lockfileGlobs, path);
}

/**
 * Splits changed files into reviewed and skipped. `paths` from the repository config come first:
 * `!` patterns exclude, the others form an allowlist that can also bring back a file ignored by
 * default.
 */
export function filterFiles(
	files: FileDiff[],
	paths: string[] = [],
	options: { sandbox?: boolean } = {}
): FilterResult {
	const allow = globs(paths.filter((p) => !p.startsWith('!')));
	const deny = globs(paths.filter((p) => p.startsWith('!')).map((p) => p.slice(1)));
	const ignored = options.sandbox
		? noiseGlobs
		: [...noiseGlobs, ...lockfileGlobs, ...generatedGlobs];

	const result: FilterResult = { included: [], excluded: [] };
	const skip = (path: string, reason: Excluded['reason']) => result.excluded.push({ path, reason });

	for (const file of files) {
		if (file.status === 'deleted') skip(file.path, 'deleted');
		else if (file.binary) skip(file.path, 'binary');
		else if (file.hunks.length === 0) skip(file.path, 'no changes');
		else if (matches(deny, file.path)) skip(file.path, 'excluded by paths');
		else if (allow.length > 0 && !matches(allow, file.path)) skip(file.path, 'not in paths');
		else if (allow.length === 0 && matches(ignored, file.path)) skip(file.path, 'ignored');
		else result.included.push(file);
	}
	return result;
}
