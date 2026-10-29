import { describe, expect, test } from 'bun:test';
import { finalTier, standingFromOpenFindings, tierCap } from './tier';

describe('tierCap', () => {
	test('the worst open severity decides', () => {
		expect(tierCap([])).toBe('S');
		expect(tierCap(['info'])).toBe('S');
		expect(tierCap(['minor', 'info'])).toBe('A');
		expect(tierCap(['minor', 'major'])).toBe('B');
		expect(tierCap(['critical', 'minor'])).toBe('D');
	});
});

describe('finalTier', () => {
	test('never grades better than the cap', () => {
		expect(finalTier('S', 'A')).toBe('A');
		expect(finalTier('C', 'A')).toBe('C');
		expect(finalTier(undefined, 'B')).toBe('B');
	});
});

describe('standingFromOpenFindings', () => {
	test('with nothing open the pull request is mergeable', () => {
		expect(standingFromOpenFindings([])).toEqual({ tier: 'S', tierReason: '' });
	});

	test('an open finding caps the tier and explains why', () => {
		expect(
			standingFromOpenFindings([
				{ severity: 'info', title: 'Naming' },
				{ severity: 'minor', title: '/api responses bypass robots meta' }
			])
		).toEqual({
			tier: 'A',
			tierReason: 'Limited by an open minor finding: /api responses bypass robots meta'
		});
	});

	test('the worst severity wins when several findings remain', () => {
		expect(
			standingFromOpenFindings([
				{ severity: 'minor', title: 'Typos' },
				{ severity: 'major', title: 'Off by one' }
			])
		).toEqual({
			tier: 'B',
			tierReason: 'Limited by an open major finding: Off by one'
		});
	});
});
