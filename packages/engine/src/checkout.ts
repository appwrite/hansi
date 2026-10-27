import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILES, parseConfig, type ConfigResult } from './config';
import { parseGitDiff, type FileDiff } from './diff';
import { git, isMissingPath } from './git';
import type { GitRemote } from './github';

// A local copy of the pull request for the review's tools. A blobless partial clone: the
// history comes along (file_history needs it), file contents are fetched as they are read.

export interface Checkout {
	dir: string;
	/** Removes the checkout. Safe to call more than once. */
	remove(): Promise<void>;
}

/** Fetches `headSha` and `baseSha` and checks out the head. */
export async function checkout(
	remote: GitRemote,
	commits: { headSha: string; baseSha: string },
	signal?: AbortSignal
): Promise<Checkout> {
	const dir = await mkdtemp(join(tmpdir(), 'hansi-checkout-'));
	const remove = () => rm(dir, { recursive: true, force: true });
	const options = { cwd: dir, token: remote.token, signal };
	try {
		await git(['init', '--quiet'], options);
		await git(['remote', 'add', 'origin', remote.url], options);
		await git(
			[
				'fetch',
				'--quiet',
				'--no-tags',
				'--filter=blob:none',
				'origin',
				commits.headSha,
				commits.baseSha
			],
			options
		);
		await git(['checkout', '--quiet', '--detach', commits.headSha], options);
	} catch (error) {
		await remove();
		throw error;
	}
	return { dir, remove };
}

/** The repository's settings at `ref`, from the first config file that exists. */
export async function readRepoConfig(
	dir: string,
	ref: string,
	token?: string
): Promise<ConfigResult> {
	for (const file of CONFIG_FILES) {
		try {
			return parseConfig(await git(['show', `${ref}:${file}`], { cwd: dir, token }));
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
	}
	return parseConfig(null);
}

/** What the pull request changes between the two commits of a checkout. */
export async function changedFiles(
	dir: string,
	commits: { headSha: string; baseSha: string },
	options: { token?: string; signal?: AbortSignal } = {}
): Promise<FileDiff[]> {
	return parseGitDiff(
		await git(
			[
				// Unquoted paths: parseGitDiff reads them as they are.
				'-c',
				'core.quotePath=false',
				'diff',
				'--no-color',
				'--no-ext-diff',
				'--find-renames',
				'--src-prefix=a/',
				'--dst-prefix=b/',
				`${commits.baseSha}...${commits.headSha}`
			],
			{ cwd: dir, ...options }
		)
	);
}
