import { z } from 'zod';
import { severities, type Severity } from './grading';

// Per-repository settings, read from the base branch so a pull request cannot change how it is
// reviewed. Every field is optional; a broken file falls back to the defaults and says why.

/** Where the settings live, first match wins. The product name, and so the file name, is not settled yet. */
export const CONFIG_FILES = ['.hansi.json'] as const;

export const profiles = ['chill', 'balanced', 'strict'] as const;
export type Profile = (typeof profiles)[number];

export const repoConfigSchema = z.object({
	reviews: z
		.object({
			enabled: z.boolean().default(true).describe('Review pull requests in this repository.'),
			auto: z
				.boolean()
				.default(true)
				.describe('Review when a pull request is opened or pushed to. Mentions work either way.'),
			drafts: z.boolean().default(false).describe('Review draft pull requests too.'),
			baseBranches: z
				.array(z.string())
				.default([])
				.describe('Only review pull requests into these branches. Empty means every branch.'),
			paths: z
				.array(z.string())
				.default([])
				.describe('Globs of files to review. A leading ! excludes, e.g. "!docs/**".'),
			profile: z
				.enum(profiles)
				.default('balanced')
				.describe(
					'chill reports only bugs it can show in the code; balanced adds risky patterns, missing or weak tests and broken documentation; strict adds naming, style and maintainability.'
				),
			minSeverity: z
				.enum(severities)
				.default('minor')
				.describe('Findings below this severity are not posted.'),
			maxComments: z
				.number()
				.int()
				.min(0)
				.max(100)
				.default(15)
				.describe('The most inline comments one review posts.'),
			approve: z
				.boolean()
				.default(true)
				.describe('Approve pull requests with nothing blocking and no open defect.'),
			requestChanges: z
				.enum([...severities, 'never'])
				.default('major')
				.describe(
					'Findings at or above this severity request changes. never only comments, and still never approves over a major or critical finding.'
				),
			approveOutsideContributors: z
				.boolean()
				.default(false)
				.describe(
					'Approve pull requests from authors without write access. Off by default: their code could try to talk the model into an approval.'
				)
		})
		.prefault({}),
	instructions: z.string().default('').describe('Extra review instructions, in plain language.'),
	pathInstructions: z
		.array(z.object({ path: z.string(), instructions: z.string() }))
		.default([])
		.describe('Instructions for files matching a glob.'),
	language: z.string().default('en').describe('Language of review comments.'),
	sandbox: z
		.object({
			setup: z.string().default('').describe('Shell command run before the review, e.g. "npm ci".'),
			network: z
				.enum(['public', 'none'])
				.default('public')
				.describe('public reaches public hosts over HTTP(S); none has no network.')
		})
		.prefault({})
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const defaultConfig: RepoConfig = repoConfigSchema.parse({});

export interface ConfigResult {
	config: RepoConfig;
	/** Why the file was not used. Empty when it was, or when there is none. */
	errors: string[];
}

/** Parses a config file. An unreadable file yields the defaults and the reasons. */
export function parseConfig(source: string | null | undefined): ConfigResult {
	if (!source?.trim()) return { config: defaultConfig, errors: [] };

	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (error) {
		return {
			config: defaultConfig,
			errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
		};
	}

	const result = repoConfigSchema.safeParse(raw ?? {});
	if (result.success) return { config: result.data, errors: [] };
	return {
		config: defaultConfig,
		errors: result.error.issues.map(
			(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
		)
	};
}

/** The severity from which a finding blocks the pull request. */
export function blockingSeverity(config: RepoConfig): Severity {
	const setting = config.reviews.requestChanges;
	return setting === 'never' ? 'major' : setting;
}
