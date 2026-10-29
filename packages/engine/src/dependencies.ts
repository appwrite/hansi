import type { FileDiff } from './diff';
import { isLockfile } from './filters';

export interface DependencyChange {
	/** The lockfile the change was read from. */
	lockfile: string;
	name: string;
	/** Null when the package is new. */
	from: string | null;
	/** Null when the package was removed. */
	to: string | null;
}

const MAX_CHANGES = 200;

/**
 * Package versions a pull request's lockfile diffs add, remove, or change. Best effort: it reads
 * the common lockfile formats line by line, and a format it does not know yields nothing.
 */
export function dependencyChanges(files: FileDiff[]): DependencyChange[] {
	const changes: DependencyChange[] = [];
	for (const file of files) {
		if (!isLockfile(file.path)) continue;
		changes.push(...lockfileChanges(file));
		if (changes.length >= MAX_CHANGES) break;
	}
	return changes.slice(0, MAX_CHANGES);
}

type Side = 'removed' | 'added';
type Entry = { name: string; version: string; side: Side };

function lockfileChanges(file: FileDiff): DependencyChange[] {
	const read = readerFor(file.path);
	const entries: Entry[] = [];
	for (const hunk of file.hunks) {
		let name: string | null = null;
		for (const line of hunk.lines) {
			const parsed = read(line.content, name);
			if (parsed.name !== undefined) name = parsed.name;
			if (!parsed.version || line.type === 'context') continue;
			const entryName = parsed.entryName ?? name;
			if (!entryName) continue;
			entries.push({
				name: entryName,
				version: parsed.version,
				side: line.type === 'del' ? 'removed' : 'added'
			});
		}
	}
	return pair(file.path, entries);
}

/** Matches removed and added versions of the same package into one change per package. */
function pair(lockfile: string, entries: Entry[]): DependencyChange[] {
	const byName = new Map<string, { removed: Set<string>; added: Set<string> }>();
	for (const entry of entries) {
		const sides = byName.get(entry.name) ?? { removed: new Set(), added: new Set() };
		sides[entry.side].add(entry.version);
		byName.set(entry.name, sides);
	}
	const changes: DependencyChange[] = [];
	for (const [name, { removed, added }] of byName) {
		const from = [...removed].filter((v) => !added.has(v));
		const to = [...added].filter((v) => !removed.has(v));
		if (from.length === 0 && to.length === 0) continue;
		changes.push({ lockfile, name, from: from.join(', ') || null, to: to.join(', ') || null });
	}
	return changes;
}

/**
 * Reads one lockfile line. `name` sets the package the following lines belong to; `version` is a
 * version on this line, for `entryName` when the line names its own package, else for the
 * current one.
 */
type LineReader = (
	content: string,
	current: string | null
) => { name?: string | null; version?: string; entryName?: string };

function readerFor(path: string): LineReader {
	const base = path.split('/').pop() ?? path;
	if (base === 'composer.lock') return composerLock;
	if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return packageLock;
	if (base === 'yarn.lock') return yarnLock;
	if (base === 'bun.lock') return bunLock;
	if (base === 'pnpm-lock.yaml') return pnpmLock;
	if (base === 'go.sum') return goSum;
	if (base === 'Gemfile.lock') return gemfileLock;
	// Cargo.lock, poetry.lock, uv.lock, and other TOML lockfiles.
	return tomlLock;
}

const composerLock: LineReader = (content) => {
	const name = content.match(/^\s*"name":\s*"([^"]+)"/);
	if (name) return { name: name[1] };
	const version = content.match(/^\s*"version":\s*"([^"]+)"/);
	return version ? { version: version[1] } : {};
};

const packageLock: LineReader = (content) => {
	const key = content.match(/^\s*"((?:[^"]*\/)?node_modules\/[^"]+)":\s*\{/);
	if (key) return { name: key[1]!.replace(/^.*node_modules\//, '') };
	const version = content.match(/^\s*"version":\s*"([^"]+)"/);
	return version ? { version: version[1] } : {};
};

const yarnLock: LineReader = (content) => {
	// `foo@^1.0.0, foo@^1.2.0:` (v1) or `"@scope/foo@npm:^1.0.0":` (berry).
	if (/^\S.*:$/.test(content)) {
		const first = content.replace(/^"/, '').split(/,\s*/)[0] ?? '';
		const at = first.lastIndexOf('@');
		return { name: at > 0 ? first.slice(0, at) : null };
	}
	const version = content.match(/^\s+version:?\s+"?([^"\s]+)"?/);
	return version ? { version: version[1] } : {};
};

const bunLock: LineReader = (content) => {
	// `"foo": ["foo@1.2.3", "", { ... }, "sha512-..."],`
	const entry = content.match(/^\s*"[^"]+":\s*\["((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/);
	const [, name, version] = entry ?? [];
	if (!name || !version || version.startsWith('workspace:')) return {};
	return { entryName: name, version: version.replace(/^npm:/, '') };
};

const pnpmLock: LineReader = (content) => {
	// `  /foo@1.2.3:`, `  foo@1.2.3:`, or `  '@scope/foo@1.2.3(peer@1.0.0)':` under packages.
	const entry = content.match(/^\s{2}'?\/?((?:@[^@/']+\/)?[^@/'\s]+)@([^('\s:]+)[^:]*'?:\s*$/);
	return entry ? { entryName: entry[1], version: entry[2] } : {};
};

const goSum: LineReader = (content) => {
	const entry = content.match(/^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+h1:/);
	return entry ? { entryName: entry[1], version: entry[2] } : {};
};

const gemfileLock: LineReader = (content) => {
	// Four spaces: a locked gem. Six: one of its requirements, not a locked version.
	const entry = content.match(/^ {4}([^\s(]+) \(([^)\s,]+)\)$/);
	return entry ? { entryName: entry[1], version: entry[2] } : {};
};

const tomlLock: LineReader = (content) => {
	if (content.trim() === '[[package]]') return { name: null };
	const name = content.match(/^name\s*=\s*"([^"]+)"/);
	if (name) return { name: name[1] };
	const version = content.match(/^version\s*=\s*"([^"]+)"/);
	return version ? { version: version[1] } : {};
};

/** Splits a version into numbers, ignoring a leading `v`. Null when it is not semver-like. */
function versionParts(version: string): number[] | null {
	const match = version.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
	return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

/**
 * Whether going from `from` to `to` may break callers under semver: a new major version, or a
 * new minor version before 1.0.
 */
export function isMajorBump(from: string, to: string): boolean {
	const [a, b] = [versionParts(from), versionParts(to)];
	if (!a || !b) return false;
	const [aMajor = 0, aMinor = 0] = a;
	const [bMajor = 0, bMinor = 0] = b;
	if (bMajor !== aMajor) return bMajor > aMajor;
	return aMajor === 0 && bMinor > aMinor;
}

/** One line per change, such as `- composer.lock: psr/log 3.0.0 -> 3.0.2`. */
export function formatDependencyChanges(changes: DependencyChange[]): string {
	return changes
		.map((c) => {
			const move =
				c.from && c.to ? `${c.from} -> ${c.to}` : c.to ? `added ${c.to}` : `removed ${c.from}`;
			const major = c.from && c.to && isMajorBump(c.from, c.to) ? ' (major)' : '';
			return `- ${c.lockfile}: ${c.name} ${move}${major}`;
		})
		.join('\n');
}
