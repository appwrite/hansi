import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { severities, verdicts } from '@hansi/engine';
import { z } from 'zod';

// An eval case is one pull request with what a good review of it finds. Cases live in
// `cases/<id>/case.json`; a case may carry `inject.patch`, applied on top of the head as one more
// commit, to plant a known bug in a real pull request without pushing anything anywhere.

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit SHA');

export const expectedFindingSchema = z.object({
	/** Short, stable name for the problem, used in reports, e.g. `missing-await`. */
	id: z.string().min(1),
	path: z.string().min(1),
	/** New-file lines the problem is on, first and last. A finding counts near them. */
	lines: z
		.tuple([z.number().int().positive(), z.number().int().positive()])
		.refine(([start, end]) => end >= start, 'the last line comes after the first'),
	/** What is wrong, in a sentence or two: what the judge compares a finding against. */
	issue: z.string().min(1),
	/** The least severity a finding needs to count. Unset counts any severity. */
	severity: z.enum(severities).optional()
});

export const caseSchema = z.object({
	/** What the case checks, for whoever reads a report. */
	description: z.string().min(1),
	/** Where the case comes from, e.g. the pull request and the commit that fixed the bug. */
	source: z.string().optional(),
	/** `owner/name` on GitHub, or a clone URL. */
	repo: z.string().min(1),
	/** Pull request number; its head is fetched from `refs/pull/<n>/head`, so forks work. */
	pull: z.number().int().positive().optional(),
	base: sha,
	head: sha,
	pullRequest: z.object({
		title: z.string(),
		body: z.string().default(''),
		author: z.string().default('octocat')
	}),
	/**
	 * The repository settings, as in `.hansi.json`. Unset reads `.hansi.json` from the base commit,
	 * as a review does.
	 */
	config: z.record(z.string(), z.unknown()).optional(),
	linkedIssues: z
		.array(z.object({ number: z.number().int(), title: z.string(), body: z.string() }))
		.default([]),
	expected: z.object({
		/** The verdict a good review reaches. Unset is not scored. */
		verdict: z.enum(verdicts).optional(),
		/** Every problem a good review reports. Empty means a clean pull request. */
		findings: z.array(expectedFindingSchema)
	})
});

export type ExpectedFinding = z.infer<typeof expectedFindingSchema>;

export interface EvalCase extends z.infer<typeof caseSchema> {
	id: string;
	/** Absolute path of `inject.patch`, when the case has one. */
	patch?: string;
}

export const CASE_FILE = 'case.json';
export const PATCH_FILE = 'inject.patch';

/** The clone URL of a case's repository. */
export function cloneUrl(repo: string): string {
	return repo.includes('://') || repo.startsWith('git@') ? repo : `https://github.com/${repo}.git`;
}

/**
 * Whether a clone URL is on github.com. Only those get `GITHUB_TOKEN`: git sends a token as a
 * header to whatever host it fetches from, and a case may name any host.
 */
export function isGitHubUrl(url: string): boolean {
	try {
		return new URL(url).hostname === 'github.com';
	} catch {
		return false;
	}
}

/** Reads one case directory. Throws with the case id and every problem in its file. */
export async function loadCase(dir: string, id: string): Promise<EvalCase> {
	const raw = JSON.parse(await readFile(join(dir, CASE_FILE), 'utf8')) as unknown;
	const parsed = caseSchema.safeParse(raw);
	if (!parsed.success) {
		const problems = parsed.error.issues.map(
			(i) => `${i.path.join('.') || '(root)'}: ${i.message}`
		);
		throw new Error(`case ${id} is invalid:\n  ${problems.join('\n  ')}`);
	}
	const ids = parsed.data.expected.findings.map((f) => f.id);
	const repeated = ids.find((findingId, index) => ids.indexOf(findingId) !== index);
	if (repeated)
		throw new Error(`case ${id} is invalid:\n  expected finding ${repeated} is listed twice`);

	const patch = join(dir, PATCH_FILE);
	const hasPatch = await stat(patch).then(
		(s) => s.isFile(),
		() => false
	);
	return { ...parsed.data, id, ...(hasPatch && { patch }) };
}

/** Every case under `root`, by id, keeping those whose id contains one of `filters`. */
export async function loadCases(root: string, filters: string[] = []): Promise<EvalCase[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const ids = entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.filter((id) => filters.length === 0 || filters.some((f) => id.includes(f)))
		.sort();
	return Promise.all(ids.map((id) => loadCase(join(root, id), id)));
}
