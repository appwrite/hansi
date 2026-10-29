import { describe, expect, test } from 'bun:test';
import { presentReview, summaryWithoutDroppedFindings, type PresentationFinding } from './present';

const major = (title: string, body?: string): PresentationFinding => ({
	severity: 'major',
	title,
	...(body ? { body } : {})
});

describe('summaryWithoutDroppedFindings', () => {
	test('drops a paraphrased authorization bypass that was filtered, and a judgement with no posted finding', () => {
		// appwrite#14228: the headline described a finding that was never posted.
		const summary = summaryWithoutDroppedFindings(
			'Adds a Videos service. Child-resource mutations bypass write authorization, and several playback and build paths need fixes.',
			[
				major('Require mutation permission before changing video children'),
				major('Distinguish CMAF-DASH captions from CMAF-HLS captions'),
				major('Emit a playable variant for audio-only HLS outputs')
			],
			[major('Do not require an SSH agent for the default development build')]
		);
		expect(summary).toBe('Adds a Videos service.');
		expect(summary.toLowerCase()).not.toContain('bypass');
		expect(summary.toLowerCase()).not.toContain('authorization');
		expect(summary.toLowerCase()).not.toContain('need fixes');
	});

	test('keeps the still-open half of a sentence and drops the filtered half', () => {
		// appwrite#14027: the summary led with a finding Hansi had filtered out.
		const summary = summaryWithoutDroppedFindings(
			'The new mail error path discards failed jobs rather than retaining them for diagnosis or recovery, and the previously reported prohibited worker regression remains present.',
			[major('Retain thrown mail failures instead of acknowledging them as success')],
			[major('Prohibited worker regression')]
		);
		expect(summary.toLowerCase()).toContain('prohibited worker regression');
		expect(summary.toLowerCase()).not.toContain('mail');
		expect(summary.toLowerCase()).not.toContain('discard');
	});

	test("keeps a change description that shares the filtered finding's vocabulary", () => {
		const original = 'Adds child video mutation endpoints and permission checks for playback.';
		expect(
			summaryWithoutDroppedFindings(
				original,
				[
					major(
						'Require mutation permission before changing video children',
						'A member can change video children without a write check.'
					)
				],
				[]
			)
		).toBe(original);
	});

	test('drops a clause that copies a filtered title', () => {
		expect(
			summaryWithoutDroppedFindings(
				'Require mutation permission before changing video children. Adds the Videos service.',
				[major('Require mutation permission before changing video children')],
				[]
			)
		).toBe('Adds the Videos service.');
	});

	test('leaves the summary unchanged when nothing was filtered', () => {
		const original = 'The handler bypasses authorization, and several paths need fixes.';
		expect(summaryWithoutDroppedFindings(original, [], [])).toBe(original);
	});

	test('leaves an unrelated summary unchanged when other findings were filtered', () => {
		expect(
			summaryWithoutDroppedFindings('Refactors divide.', [major('Outside diff', 'Explained.')], [])
		).toBe('Refactors divide.');
	});

	test('replaces a summary that was only about filtered findings', () => {
		expect(
			summaryWithoutDroppedFindings(
				'Child-resource mutations bypass write authorization.',
				[major('Require mutation permission before changing video children')],
				[]
			)
		).toBe('Reviewed the changes in this pull request.');
	});
});

describe('presentReview grade', () => {
	test('a worse model grade stands when every finding was posted', () => {
		const grade = presentReview({
			summary: 'Refactors divide.',
			modelTier: 'D',
			modelTierReason: 'Several majors add up.',
			verdict: 'request_changes',
			posted: [major('Division by zero')],
			stillOpen: [],
			dropped: []
		});
		expect(grade.tier).toBe('D');
		expect(grade.tierReason).toBe('Several majors add up.');
	});

	test('a filtered finding cannot pull the grade below the posted findings', () => {
		// One posted major caps at B. The model said D because of a filtered critical.
		const grade = presentReview({
			summary: 'Adds a Videos service.',
			modelTier: 'D',
			modelTierReason: 'Child-resource mutations bypass write authorization.',
			verdict: 'request_changes',
			posted: [major('Do not require an SSH agent for the default development build')],
			stillOpen: [],
			dropped: [
				{
					...major('Require mutation permission before changing video children'),
					severity: 'critical'
				}
			]
		});
		expect(grade.tier).toBe('B');
		expect(grade.tierReason).toBe(
			'Limited by an open major finding: Do not require an SSH agent for the default development build'
		);
		expect(grade.tierReason).not.toContain('bypass');
	});

	test('with nothing left open, filtered findings do not keep a lower grade or its reason', () => {
		const grade = presentReview({
			summary: 'Fine.',
			modelTier: 'B',
			modelTierReason: 'Off the diff.',
			verdict: 'approve',
			posted: [],
			stillOpen: [],
			dropped: [major('Off the diff')]
		});
		expect(grade).toMatchObject({ tier: 'S', tierReason: '', summary: 'Fine.' });
	});

	test('an approval is not graded below A, and the cap still wins', () => {
		const minor = presentReview({
			summary: 'Still the SEO metadata change.',
			modelTier: 'B',
			modelTierReason: 'The previously reported robots meta issue remains unresolved.',
			verdict: 'approve',
			posted: [],
			stillOpen: [{ severity: 'minor', title: '/api responses bypass this robots meta tag' }],
			dropped: []
		});
		expect(minor.tier).toBe('A');
		expect(minor.tierReason).toBe(
			'Limited by an open minor finding: /api responses bypass this robots meta tag'
		);

		const majorOpen = presentReview({
			summary: 'Still open major elsewhere.',
			modelTier: 'C',
			modelTierReason: 'Needs more work.',
			verdict: 'approve',
			posted: [],
			stillOpen: [major('Division by zero')],
			dropped: []
		});
		expect(majorOpen.tier).toBe('B');
		expect(majorOpen.tierReason).toBe('Limited by an open major finding: Division by zero');
	});
});
