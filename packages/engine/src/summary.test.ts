import { describe, expect, test } from 'bun:test';
import { formatSummaryComment } from './format';
import { hasBlockingOpen, summaryAfterSettlement, summaryExtrasFromBody } from './summary';

const base = {
	repository: 'acme/api',
	headSha: 'abcdef1234567890',
	summary: 'Adds pagination to the items endpoint.',
	verdict: 'approve' as const,
	walkthrough: [{ path: 'src/paginate.ts', change: 'Switches to 1-based pages.' }],
	latestReviewId: 'review-2',
	detailsUrl: 'https://hans.example/app/acme/reviews/review-2',
	mention: '@hansi-codes'
};

const earlierFinding = {
	reviewId: 'review-1',
	path: 'apps/web/src/routes/+layout.svelte',
	startLine: 112,
	endLine: 112,
	severity: 'minor',
	category: 'bug',
	title: '/api responses bypass this robots meta tag',
	body: 'API responses never see the layout meta tag.',
	suggestion: null,
	status: 'posted',
	dropReason: null
};

describe('summaryAfterSettlement', () => {
	test('dropping the last open finding clears it from the summary and grades S', () => {
		const input = summaryAfterSettlement({
			...base,
			findings: []
		});
		expect(input.tier).toBe('S');
		expect(input.tierReason).toBe('');
		expect(input.stillOpen).toEqual([]);

		const body = formatSummaryComment(input);
		expect(body).toContain('## 🟢 Tier S');
		expect(body).toContain('| ✅ Approved | 0 | 0 | 0 |');
		expect(body).not.toContain('Still open from earlier reviews');
		expect(body).not.toContain('/api responses bypass');
	});

	test('keeps other earlier findings in the still-open list', () => {
		const input = summaryAfterSettlement({
			...base,
			findings: [earlierFinding]
		});
		expect(input.tier).toBe('A');
		expect(input.tierReason).toBe(
			'Limited by an open minor finding: /api responses bypass this robots meta tag'
		);
		expect(input.stillOpen).toEqual([
			{
				path: earlierFinding.path,
				startLine: 112,
				endLine: 112,
				title: earlierFinding.title,
				body: earlierFinding.body,
				severity: 'minor'
			}
		]);

		const body = formatSummaryComment(input);
		expect(body).toContain('Still open from earlier reviews');
		expect(body).toContain('/api responses bypass this robots meta tag');
	});

	test('keeps a stored suggestion in the rebuilt prompt for an earlier finding', () => {
		const input = summaryAfterSettlement({
			...base,
			findings: [{ ...earlierFinding, suggestion: 'addRobotsMeta();\n' }]
		});
		expect(input.stillOpen[0]?.suggestion).toBe('addRobotsMeta();\n');
		expect(formatSummaryComment(input)).toContain('```suggestion\naddRobotsMeta();\n```');
	});

	test('findings from the latest review stay under new comments, not still open', () => {
		const input = summaryAfterSettlement({
			...base,
			findings: [{ ...earlierFinding, reviewId: 'review-2' }]
		});
		expect(input.posted).toHaveLength(1);
		expect(input.stillOpen).toEqual([]);
		expect(input.tier).toBe('A');
	});

	test('carries latest-changes, withheld approval, and incremental scope through a rebuild', () => {
		const input = summaryAfterSettlement({
			...base,
			verdict: 'comment',
			findings: [],
			latestChanges: 'Adds pageCount.',
			approvalWithheld: '@stranger does not have write access to this repository.',
			incrementalFrom: '11e59f1'
		});
		const body = formatSummaryComment(input);
		expect(body).toContain('**Latest changes:** Adds pageCount.');
		expect(body).toContain('> [!NOTE]\n> @stranger does not have write access to this repository.');
		expect(body).toContain('Reviewed the commits since <code>11e59f1</code>');
	});
});

describe('summaryExtrasFromBody', () => {
	test('reads review-context details that are only in the comment body', () => {
		const body = formatSummaryComment(
			summaryAfterSettlement({
				...base,
				verdict: 'comment',
				findings: [],
				latestChanges: 'Adds pageCount.',
				approvalWithheld: '@stranger does not have write access.',
				incrementalFrom: 'abcdef1234567890'
			})
		);
		expect(summaryExtrasFromBody(body)).toEqual({
			latestChanges: 'Adds pageCount.',
			approvalWithheld: '@stranger does not have write access.',
			filesTooLargeForPrompt: null,
			staleHead: null,
			incrementalFrom: 'abcdef1'
		});
	});

	test('keeps a stale-head note distinct from a withheld approval', () => {
		const staleHead =
			'Newer commits exist (`8c9e110`) and will be reviewed. This review is of `410aa75` and does not approve it.';
		const body = formatSummaryComment(
			summaryAfterSettlement({
				...base,
				verdict: 'comment',
				findings: [],
				approvalWithheld: '@stranger does not have write access.',
				staleHead
			})
		);
		expect(summaryExtrasFromBody(body)).toMatchObject({
			approvalWithheld: '@stranger does not have write access.',
			staleHead
		});
		const rebuilt = formatSummaryComment(
			summaryAfterSettlement({
				...base,
				verdict: 'comment',
				findings: [],
				...summaryExtrasFromBody(body)
			})
		);
		expect(rebuilt).toContain(staleHead);
		expect(rebuilt).toContain('@stranger does not have write access.');
	});

	test('returns nulls when those sections are absent', () => {
		expect(
			summaryExtrasFromBody(formatSummaryComment(summaryAfterSettlement({ ...base, findings: [] })))
		).toEqual({
			latestChanges: null,
			approvalWithheld: null,
			filesTooLargeForPrompt: null,
			staleHead: null
		});
	});

	test('keeps the prompt-coverage note and unattached findings through a rebuild', () => {
		const input = summaryAfterSettlement({
			...base,
			findings: [
				{
					...earlierFinding,
					reviewId: 'review-2',
					status: 'dropped',
					dropReason: 'Lines outside the changed hunks',
					title: 'Caption manifest mixes formats'
				}
			],
			filesTooLargeForPrompt: { omitted: 3, total: 12 }
		});
		const body = formatSummaryComment(input);
		expect(body).toContain('3 of 12 changed files were too large to include in full.');
		expect(body).toContain("### Couldn't attach to a line");
		expect(body).toContain('Caption manifest mixes formats');
		expect(body).toContain('Lines outside the changed hunks');
		expect(body).not.toContain(
			'| Caption manifest mixes formats | Lines outside the changed hunks |'
		);
		expect(summaryExtrasFromBody(body)).toMatchObject({
			filesTooLargeForPrompt: { omitted: 3, total: 12 },
			staleHead: null
		});
	});

	test('keeps every line of a multiline latest-changes value', () => {
		const body = formatSummaryComment(
			summaryAfterSettlement({
				...base,
				findings: [],
				latestChanges: 'Adds pageCount.\nMentions the helper.'
			})
		);
		expect(summaryExtrasFromBody(body).latestChanges).toBe('Adds pageCount.\nMentions the helper.');
	});
});

test('hasBlockingOpen counts only open findings at the blocking severity', () => {
	expect(hasBlockingOpen([{ status: 'posted', severity: 'major' }], 'major')).toBe(true);
	expect(hasBlockingOpen([{ status: 'posted', severity: 'minor' }], 'major')).toBe(false);
	expect(hasBlockingOpen([{ status: 'resolved', severity: 'critical' }], 'major')).toBe(false);
	expect(hasBlockingOpen([{ status: 'dropped', severity: 'critical' }], 'major')).toBe(false);
	expect(hasBlockingOpen([], 'major')).toBe(false);
});
