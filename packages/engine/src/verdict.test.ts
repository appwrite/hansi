import { describe, expect, test } from 'bun:test';
import { parseRepoConfig } from './config';
import { finalTier, tierCap } from './tier';
import { decideVerdict, openDefectApprovalReason } from './verdict';

const config = (json = '') => parseRepoConfig(json).config;

const defectCategories = ['bug', 'security', 'concurrency', 'error-handling'] as const;
const noteCategories = ['testing', 'documentation', 'maintainability', 'performance'] as const;

describe('decideVerdict', () => {
	test('requests changes for new blocking findings', () => {
		expect(
			decideVerdict({ posted: [{ severity: 'major' }], stillOpen: [], config: config() })
		).toBe('request_changes');
		expect(
			decideVerdict({
				posted: [{ severity: 'major', category: 'bug' }],
				stillOpen: [],
				config: config()
			})
		).toBe('request_changes');
	});

	test('approves with only minor comments that are not defects', () => {
		expect(
			decideVerdict({ posted: [{ severity: 'minor' }], stillOpen: [], config: config() })
		).toBe('approve');
		for (const category of noteCategories) {
			expect(
				decideVerdict({
					posted: [{ severity: 'minor', category }],
					stillOpen: [{ severity: 'minor', category }],
					config: config()
				})
			).toBe('approve');
		}
	});

	test('comments instead of approving while a minor defect is open', () => {
		for (const category of defectCategories) {
			const finding = { severity: 'minor' as const, category, title: 'Nested cache' };
			expect(decideVerdict({ posted: [finding], stillOpen: [], config: config() })).toBe('comment');
			expect(decideVerdict({ posted: [], stillOpen: [finding], config: config() })).toBe('comment');
		}
		// A testing note posted alongside an earlier bug still must not approve.
		expect(
			decideVerdict({
				posted: [{ severity: 'minor', category: 'testing' }],
				stillOpen: [{ severity: 'minor', category: 'bug', title: 'Nested cache' }],
				config: config()
			})
		).toBe('comment');
	});

	test('an info bug does not withhold approval', () => {
		expect(
			decideVerdict({
				posted: [{ severity: 'info', category: 'bug', title: 'Note' }],
				stillOpen: [],
				config: config()
			})
		).toBe('approve');
	});

	test('keeps an earlier request for changes in place while blockers are open', () => {
		expect(
			decideVerdict({ posted: [], stillOpen: [{ severity: 'major' }], config: config() })
		).toBe('comment');
	});

	test('a defect below the blocking threshold comments and does not request changes', () => {
		const strict = config('{ "reviews": { "requestChanges": "critical" } }');
		expect(
			decideVerdict({
				posted: [{ severity: 'major', category: 'bug', title: 'Division by zero' }],
				stillOpen: [],
				config: strict
			})
		).toBe('comment');
		expect(
			decideVerdict({
				posted: [],
				stillOpen: [{ severity: 'major', category: 'security' }],
				config: strict
			})
		).toBe('comment');
		// The same severity on a non-defect can still be approved.
		expect(
			decideVerdict({
				posted: [{ severity: 'major', category: 'maintainability' }],
				stillOpen: [],
				config: strict
			})
		).toBe('approve');
	});

	test('respects requestChanges and approve settings', () => {
		const never = config('{ "reviews": { "requestChanges": "never" } }');
		expect(
			decideVerdict({ posted: [{ severity: 'critical' }], stillOpen: [], config: never })
		).toBe('comment');
		expect(
			decideVerdict({
				posted: [{ severity: 'minor', category: 'error-handling' }],
				stillOpen: [],
				config: never
			})
		).toBe('comment');
		const strict = config('{ "reviews": { "requestChanges": "minor" } }');
		expect(decideVerdict({ posted: [{ severity: 'minor' }], stillOpen: [], config: strict })).toBe(
			'request_changes'
		);
		expect(
			decideVerdict({
				posted: [{ severity: 'minor', category: 'bug' }],
				stillOpen: [],
				config: strict
			})
		).toBe('request_changes');
		const noApprove = config('{ "reviews": { "approve": false } }');
		expect(decideVerdict({ posted: [], stillOpen: [], config: noApprove })).toBe('comment');
	});
});

describe('openDefectApprovalReason', () => {
	test('names the open defect when it is why Hansi did not approve', () => {
		expect(
			openDefectApprovalReason(
				[{ severity: 'minor', category: 'bug', title: 'Include nested rows in the purge' }],
				config()
			)
		).toBe('Not approving while a bug finding is open: Include nested rows in the purge');
	});

	test('names the most severe defect below the threshold', () => {
		const strict = config('{ "reviews": { "requestChanges": "critical" } }');
		expect(
			openDefectApprovalReason(
				[
					{ severity: 'minor', category: 'bug', title: 'Small' },
					{ severity: 'major', category: 'security', title: 'Auth bypass' }
				],
				strict
			)
		).toBe('Not approving while a bug finding is open: Auth bypass');
	});

	test('is quiet when a finding already meets the blocking threshold', () => {
		expect(
			openDefectApprovalReason([{ severity: 'major', category: 'bug', title: 'Crash' }], config())
		).toBeNull();
	});

	test('is quiet for notes and for a defect with no title falls back', () => {
		expect(
			openDefectApprovalReason(
				[{ severity: 'minor', category: 'testing', title: 'Add a test' }],
				config()
			)
		).toBeNull();
		expect(
			openDefectApprovalReason([{ severity: 'minor', category: 'bug', title: '  ' }], config())
		).toBe('Not approving while a bug finding is open.');
	});
});

describe('tiers', () => {
	test('the worst open finding caps the tier', () => {
		expect(tierCap([])).toBe('S');
		expect(tierCap(['info'])).toBe('S');
		expect(tierCap(['minor', 'info'])).toBe('A');
		expect(tierCap(['minor', 'major'])).toBe('B');
		expect(tierCap(['critical'])).toBe('D');
	});

	test('the model can only make the tier worse, never better than the cap', () => {
		expect(finalTier('S', 'C')).toBe('C');
		expect(finalTier('F', 'D')).toBe('F');
		expect(finalTier('B', 'S')).toBe('B');
		expect(finalTier(undefined, 'B')).toBe('B');
	});
});
