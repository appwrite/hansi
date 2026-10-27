import { describe, expect, test } from 'bun:test';
import { defaultConfig, parseConfig } from './config';
import {
	decideVerdict,
	withheldApprovalReason,
	type GradedFinding,
	type VerdictInput
} from './verdict';

const finding = (
	severity: GradedFinding['severity'],
	category: GradedFinding['category'] = 'bug'
): GradedFinding => ({
	severity,
	category,
	title: `${severity} ${category}`
});

const input = (overrides: Partial<VerdictInput> = {}): VerdictInput => ({
	posted: [],
	open: [],
	config: defaultConfig,
	trustedAuthor: true,
	partial: false,
	...overrides
});

describe('decideVerdict', () => {
	test('approves a clean pull request', () => {
		expect(decideVerdict(input())).toBe('approve');
	});

	test('approves over minor non-defect notes and info', () => {
		expect(decideVerdict(input({ posted: [finding('minor', 'testing'), finding('info')] }))).toBe(
			'approve'
		);
	});

	test('requests changes for a new blocking finding', () => {
		expect(decideVerdict(input({ posted: [finding('major', 'performance')] }))).toBe(
			'request_changes'
		);
	});

	test('only comments for a blocking finding when changes are never requested', () => {
		const config = parseConfig('{"reviews":{"requestChanges":"never"}}').config;

		expect(decideVerdict(input({ posted: [finding('critical')], config }))).toBe('comment');
	});

	test('comments while an earlier blocking finding is still open', () => {
		expect(decideVerdict(input({ open: [finding('major')] }))).toBe('comment');
	});

	test('withholds approval over a minor defect', () => {
		expect(decideVerdict(input({ posted: [finding('minor', 'security')] }))).toBe('comment');
	});

	test('never approves a partial review', () => {
		expect(decideVerdict(input({ partial: true }))).toBe('comment');
	});

	test('does not approve outside contributors unless allowed', () => {
		expect(decideVerdict(input({ trustedAuthor: false }))).toBe('comment');

		const config = parseConfig('{"reviews":{"approveOutsideContributors":true}}').config;
		expect(decideVerdict(input({ trustedAuthor: false, config }))).toBe('approve');
	});

	test('still requests changes from outside contributors', () => {
		expect(decideVerdict(input({ trustedAuthor: false, posted: [finding('major')] }))).toBe(
			'request_changes'
		);
	});

	test('respects approve: false', () => {
		const config = parseConfig('{"reviews":{"approve":false}}').config;

		expect(decideVerdict(input({ config }))).toBe('comment');
	});
});

describe('withheldApprovalReason', () => {
	test('names the worst open defect', () => {
		expect(
			withheldApprovalReason([finding('minor', 'testing'), finding('minor')], defaultConfig)
		).toBe('Not approving while a bug finding is open: minor bug');
	});

	test('is null when a finding blocks or nothing is a defect', () => {
		expect(withheldApprovalReason([finding('major'), finding('minor')], defaultConfig)).toBeNull();
		expect(withheldApprovalReason([finding('minor', 'documentation')], defaultConfig)).toBeNull();
	});
});
