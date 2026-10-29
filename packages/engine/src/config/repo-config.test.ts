import { describe, expect, test } from 'bun:test';
import {
	defaultRepoConfig,
	parseRepoConfig,
	REPO_CONFIG_SCHEMA_URL,
	repoConfigJsonSchema,
	severityAtLeast
} from './repo-config';

describe('parseRepoConfig', () => {
	test('returns defaults for a missing file', () => {
		expect(parseRepoConfig(null)).toEqual({ ok: true, config: defaultRepoConfig });
		expect(defaultRepoConfig.reviews.profile).toBe('balanced');
	});

	test('merges partial config with defaults', () => {
		const result = parseRepoConfig(
			JSON.stringify({
				$schema: REPO_CONFIG_SCHEMA_URL,
				reviews: { profile: 'strict', pathFilters: ['!docs/**'] }
			})
		);
		expect(result.ok).toBe(true);
		expect(result.config.reviews.profile).toBe('strict');
		expect(result.config.reviews.pathFilters).toEqual(['!docs/**']);
		expect(result.config.reviews.maxComments).toBe(15);
	});

	test('falls back to defaults on invalid values', () => {
		const result = parseRepoConfig('{ "reviews": { "profile": "nitpicky" } }');
		expect(result.ok).toBe(false);
		expect(result.config).toEqual(defaultRepoConfig);
	});

	test('falls back to defaults on invalid JSON', () => {
		const result = parseRepoConfig('{ "reviews": ');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toStartWith('Invalid JSON');
	});
});

test('severityAtLeast', () => {
	expect(severityAtLeast('major', 'minor')).toBe(true);
	expect(severityAtLeast('info', 'minor')).toBe(false);
});

test('verdict settings default to approving and requesting changes on major findings', () => {
	expect(defaultRepoConfig.reviews.approve).toBe(true);
	expect(defaultRepoConfig.reviews.requestChanges).toBe('major');
	const commentOnly = parseRepoConfig(
		'{ "reviews": { "requestChanges": "never", "approve": false } }'
	);
	expect(commentOnly.ok).toBe(true);
	expect(commentOnly.config.reviews.requestChanges).toBe('never');
});

test('the JSON Schema describes every field and makes all of them optional', () => {
	expect(REPO_CONFIG_SCHEMA_URL).toBe('https://hansi.codes/schema/v1.json');
	expect(repoConfigJsonSchema(2)).toBeNull();
	const schema = repoConfigJsonSchema() as {
		$id: string;
		required?: string[];
		properties: Record<string, { description?: string; properties?: Record<string, unknown> }>;
	};
	expect(schema.$id).toBe(REPO_CONFIG_SCHEMA_URL);
	expect(schema.required ?? []).toEqual([]);
	expect(Object.keys(schema.properties.reviews!.properties!)).toContain('requestChanges');
	expect(schema).toMatchObject({ additionalProperties: false });
	for (const [key, property] of Object.entries(schema.properties)) {
		expect({ key, description: property.description }).toEqual({
			key,
			description: expect.any(String)
		});
	}
});

test('every review gets a sandbox; the repository can add setup or turn the network off', () => {
	expect(defaultRepoConfig.sandbox).toEqual({ setup: '', network: 'public' });
	const result = parseRepoConfig('{ "sandbox": { "setup": "npm ci", "network": "none" } }');
	expect(result.ok).toBe(true);
	expect(result.config.sandbox).toEqual({ setup: 'npm ci', network: 'none' });
});
