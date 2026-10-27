import { describe, expect, test } from 'bun:test';
import { parseGitDiff } from './diff';
import {
	dedupe,
	findingSchema,
	isDuplicate,
	placeFinding,
	titleSimilarity,
	type Dropped,
	type ReviewFinding
} from './findings';

// Two hunks: new lines 1-5 and 21-22.
const files = parseGitDiff(
	[
		'diff --git a/src/app.ts b/src/app.ts',
		'--- a/src/app.ts',
		'+++ b/src/app.ts',
		'@@ -1,4 +1,5 @@',
		' const a = 1;',
		'-const b = 2;',
		'+const b = 3;',
		'+const c = 4;',
		' ',
		' return a + b;',
		'@@ -20,2 +21,2 @@',
		'-old',
		'+new',
		' end'
	].join('\n')
);

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
	path: 'src/app.ts',
	startLine: 2,
	endLine: 3,
	severity: 'major',
	category: 'bug',
	title: 'Wrong constant for b',
	body: 'b changed from 2 to 3.',
	...overrides
});

describe('findingSchema', () => {
	test('treats a null suggestion as absent', () => {
		const parsed = findingSchema.parse({ ...finding(), suggestion: null });
		expect(parsed.suggestion).toBeUndefined();
	});
});

describe('placeFinding', () => {
	test('keeps lines inside one hunk', () => {
		expect(placeFinding(finding(), files)).toMatchObject({ startLine: 2, endLine: 3 });
	});

	test('orders reversed lines', () => {
		expect(placeFinding(finding({ startLine: 3, endLine: 2 }), files)).toMatchObject({
			startLine: 2,
			endLine: 3
		});
	});

	test('collapses a range that crosses hunks onto its end line', () => {
		expect(placeFinding(finding({ startLine: 2, endLine: 21 }), files)).toMatchObject({
			startLine: 21,
			endLine: 21
		});
	});

	test('drops findings off the diff', () => {
		expect(placeFinding(finding({ endLine: 10 }), files)).toBeNull();
		expect(placeFinding(finding({ path: 'src/other.ts' }), files)).toBeNull();
	});
});

describe('duplicates', () => {
	test('titleSimilarity compares words', () => {
		expect(titleSimilarity('Missing await on save', 'save is missing an await')).toBeGreaterThan(
			0.4
		);
		expect(titleSimilarity('Missing await on save', 'SQL injection in query')).toBe(0);
	});

	test('isDuplicate needs nearby lines and a similar title', () => {
		const earlier = [
			{ path: 'src/app.ts', startLine: 5, endLine: 5, title: 'Wrong constant for b' }
		];
		expect(isDuplicate(finding(), earlier)).toBe(true);
		expect(isDuplicate(finding({ startLine: 20, endLine: 21 }), earlier)).toBe(false);
		expect(isDuplicate(finding({ title: 'Race when saving' }), earlier)).toBe(false);
	});

	test('dedupe keeps the most severe copy', () => {
		const dropped: Dropped[] = [];
		const kept = dedupe(
			[finding({ severity: 'minor' }), finding({ severity: 'critical' })],
			dropped
		);
		expect(kept.map((f) => f.severity)).toEqual(['critical']);
		expect(dropped).toEqual([
			{ ...finding({ severity: 'minor' }), reason: 'Duplicate in this review' }
		]);
	});
});
