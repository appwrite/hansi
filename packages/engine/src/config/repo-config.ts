import { z } from 'zod';

export const severities = ['info', 'minor', 'major', 'critical'] as const;
export type Severity = (typeof severities)[number];

export const reviewProfiles = ['chill', 'balanced', 'strict'] as const;
export type ReviewProfile = (typeof reviewProfiles)[number];

/** The repository config file, read from the pull request's base branch. */
export const REPO_CONFIG_FILE = '.hansi.json';
/**
 * The current version of the config file's JSON Schema. Bump it, and keep serving the old
 * versions, when a change would make existing files invalid.
 */
export const REPO_CONFIG_SCHEMA_VERSION = 1;
/** Where a version of the JSON Schema is published, for `"$schema"` in the config file. */
export const repoConfigSchemaUrl = (version = REPO_CONFIG_SCHEMA_VERSION) =>
	`https://hansi.codes/schema/v${version}.json`;
/** The current schema's URL. `https://hansi.codes/schema.json` also serves the latest version. */
export const REPO_CONFIG_SCHEMA_URL = repoConfigSchemaUrl();

/**
 * Schema of `.hansi.json` in the repository root. Every field is optional. The descriptions end up
 * in the published JSON Schema, so editors show them.
 */
export const repoConfigSchema = z
	.object({
		$schema: z.string().optional().describe('The JSON Schema for this file.'),
		reviews: z
			.object({
				enabled: z.boolean().default(true).describe('Review pull requests in this repository.'),
				auto: z
					.boolean()
					.default(true)
					.describe(
						'Review automatically when a pull request is opened or updated. Mentions always work.'
					),
				drafts: z.boolean().default(false).describe('Also review draft pull requests.'),
				baseBranches: z
					.array(z.string())
					.default([])
					.describe('Only review pull requests into these branches. Empty means all branches.'),
				pathFilters: z
					.array(z.string())
					.default([])
					.describe(
						'Glob patterns for the files to review. Prefix a pattern with ! to exclude, e.g. "!docs/**".'
					),
				profile: z
					.enum(reviewProfiles)
					.default('balanced')
					.describe(
						'How picky to be. chill only flags bugs it can confirm in the code; balanced also flags risky patterns, weak or missing tests, and broken documentation examples; strict also counts naming and style rules and flags maintainability problems.'
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
					.describe('The most inline comments to post in one review.'),
				approve: z
					.boolean()
					.default(true)
					.describe(
						'Approve pull requests that have no blocking findings and no open bug, security, concurrency, or error-handling findings.'
					),
				requestChanges: z
					.enum([...severities, 'never'])
					.default('major')
					.describe(
						'Findings at or above this severity block the pull request: Hansi requests changes. never only comments, and never approves a pull request with major or critical findings.'
					),
				approveOutsideContributors: z
					.boolean()
					.default(false)
					.describe(
						'Approve pull requests from people without write access, e.g. from forks. Off by default: their changes could try to talk the model into approving.'
					)
			})
			.prefault({})
			.describe('When and how Hansi reviews.'),
		instructions: z
			.string()
			.default('')
			.describe('Extra review instructions for this repository, in plain language.'),
		pathInstructions: z
			.array(
				z.object({
					path: z.string().describe('Glob pattern, e.g. "migrations/**".'),
					instructions: z.string().describe('Instructions for files matching the pattern.')
				})
			)
			.default([])
			.describe('Review instructions for specific files.'),
		language: z.string().default('en').describe('Language for review comments, e.g. "en" or "de".'),
		sandbox: z
			.object({
				setup: z
					.string()
					.default('')
					.describe(
						'Shell command that runs in the sandbox before the review starts, e.g. "npm ci".'
					),
				network: z
					.enum(['public', 'none'])
					.default('public')
					.describe(
						'public allows HTTP and HTTPS to public hosts (for installing dependencies), never private networks or cloud metadata. none removes the network.'
					)
			})
			.prefault({})
			.describe('The sandbox each review runs commands in.')
	})
	.meta({ title: 'Hansi configuration', description: 'Configures Hansi for a repository.' });

export type RepoConfig = z.infer<typeof repoConfigSchema>;
/** The contents of `.hansi.json`, before defaults are applied. */
export type RepoConfigInput = z.input<typeof repoConfigSchema>;

export const defaultRepoConfig: RepoConfig = repoConfigSchema.parse({});

/**
 * The JSON Schema for a published version, or null for an unknown one. It rejects unknown keys so
 * editors flag typos; parsing is more forgiving and ignores them.
 */
export function repoConfigJsonSchema(version = REPO_CONFIG_SCHEMA_VERSION) {
	// Only v1 exists so far. A v2 would keep generating v1 from a frozen copy of its schema.
	if (version !== 1) return null;
	const schema = z.toJSONSchema(repoConfigSchema, { io: 'input' });
	const closeObjects = (node: unknown): void => {
		if (!node || typeof node !== 'object') return;
		const record = node as Record<string, unknown>;
		if (record.type === 'object' && record.properties) record.additionalProperties = false;
		Object.values(record).forEach(closeObjects);
	};
	closeObjects(schema);
	return { $id: repoConfigSchemaUrl(version), ...schema };
}

export type RepoConfigResult =
	{ ok: true; config: RepoConfig } | { ok: false; config: RepoConfig; errors: string[] };

/** Parses `.hansi.json`. Invalid files fall back to defaults and report errors instead of throwing. */
export function parseRepoConfig(source: string | null | undefined): RepoConfigResult {
	if (!source?.trim()) return { ok: true, config: defaultRepoConfig };

	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (error) {
		return {
			ok: false,
			config: defaultRepoConfig,
			errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`]
		};
	}

	const result = repoConfigSchema.safeParse(raw ?? {});
	if (result.success) return { ok: true, config: result.data };
	return {
		ok: false,
		config: defaultRepoConfig,
		errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
	};
}

/** The severity from which findings block a PR (see `reviews.requestChanges`). */
export function blockingSeverity(config: RepoConfig): Severity {
	return config.reviews.requestChanges === 'never' ? 'major' : config.reviews.requestChanges;
}

export function severityAtLeast(severity: Severity, minimum: Severity): boolean {
	return severities.indexOf(severity) >= severities.indexOf(minimum);
}
