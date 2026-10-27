import { describe, expect, test } from 'bun:test';
import { blockingSeverity, defaultConfig, parseConfig } from './config';

describe('parseConfig', () => {
	test('uses defaults without a file', () => {
		expect(parseConfig(null)).toEqual({ config: defaultConfig, errors: [] });
		expect(defaultConfig.reviews).toMatchObject({
			enabled: true,
			minSeverity: 'minor',
			requestChanges: 'major'
		});
	});

	test('fills in what the file leaves out', () => {
		const { config, errors } = parseConfig(
			'{"reviews":{"drafts":true},"sandbox":{"network":"none"}}'
		);

		expect(errors).toEqual([]);
		expect(config.reviews.drafts).toBe(true);
		expect(config.reviews.auto).toBe(true);
		expect(config.sandbox).toEqual({ setup: '', network: 'none' });
	});

	test('falls back to defaults on invalid JSON', () => {
		const { config, errors } = parseConfig('{');

		expect(config).toEqual(defaultConfig);
		expect(errors[0]).toStartWith('Not valid JSON');
	});

	test('reports a file that is not an object', () => {
		const { config, errors } = parseConfig('null');

		expect(config).toEqual(defaultConfig);
		expect(errors).toHaveLength(1);
	});

	test('names the field that is wrong', () => {
		const { config, errors } = parseConfig('{"reviews":{"maxComments":1000}}');

		expect(config).toEqual(defaultConfig);
		expect(errors[0]).toStartWith('reviews.maxComments:');
	});
});

test('blockingSeverity treats never as major', () => {
	const config = parseConfig('{"reviews":{"requestChanges":"never"}}').config;

	expect(blockingSeverity(config)).toBe('major');
	expect(blockingSeverity(parseConfig('{"reviews":{"requestChanges":"minor"}}').config)).toBe(
		'minor'
	);
});
