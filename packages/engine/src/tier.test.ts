import { describe, expect, test } from 'bun:test';
import { finalTier, standing, tierCap } from './tier';

describe('tierCap', () => {
	test('lets the worst open finding decide', () => {
		expect(tierCap([])).toBe('S');
		expect(tierCap(['info'])).toBe('S');
		expect(tierCap(['minor', 'info'])).toBe('A');
		expect(tierCap(['minor', 'major'])).toBe('B');
		expect(tierCap(['critical', 'minor'])).toBe('D');
	});
});

describe('finalTier', () => {
	test('keeps a model tier the findings allow', () => {
		expect(finalTier('C', ['minor'])).toBe('C');
	});

	test('caps a model tier that is too good', () => {
		expect(finalTier('S', ['major'])).toBe('B');
	});

	test('uses the cap without a model tier', () => {
		expect(finalTier(undefined, ['critical'])).toBe('D');
	});
});

describe('standing', () => {
	test('is S with nothing open', () => {
		expect(standing([])).toEqual({ tier: 'S', reason: '' });
	});

	test('names the worst open finding', () => {
		expect(
			standing([
				{ severity: 'minor', title: 'Typo' },
				{ severity: 'major', title: 'Leaks the token' }
			])
		).toEqual({ tier: 'B', reason: 'Limited by an open major finding: Leaks the token' });
	});
});
