import { describe, expect, test } from 'bun:test';
import type { ExpectedFinding } from './case';
import { lineDistance, matchFindings, scoreReview, type ReportedFinding } from './score';

const expected = (id: string, lines: [number, number], extra: Partial<ExpectedFinding> = {}) => ({
	id,
	path: 'src/math.ts',
	lines,
	issue: `${id} issue`,
	...extra
});
const finding = (startLine: number, extra: Partial<ReportedFinding> = {}): ReportedFinding => ({
	path: 'src/math.ts',
	startLine,
	endLine: startLine,
	severity: 'major',
	category: 'bug',
	title: `Finding at ${startLine}`,
	body: 'Explained.',
	...extra
});

describe('lineDistance', () => {
	test('is 0 inside the range and counts lines outside it', () => {
		const problem = expected('a', [10, 12]);
		expect(lineDistance(problem, finding(11))).toBe(0);
		expect(lineDistance(problem, finding(5, { endLine: 10 }))).toBe(0);
		expect(lineDistance(problem, finding(7))).toBe(3);
		expect(lineDistance(problem, finding(15))).toBe(3);
	});
});

describe('matchFindings', () => {
	test('matches the nearest finding within the tolerance, each finding once', async () => {
		const result = await matchFindings(
			[expected('a', [10, 10]), expected('b', [12, 12])],
			[finding(30), finding(11), finding(14)],
			{ tolerance: 2 }
		);
		expect(result.matches).toEqual([
			{ expected: 'a', finding: 1 },
			{ expected: 'b', finding: 2 }
		]);
		expect(result.missed).toEqual([]);
		expect(result.unmatched).toEqual([0]);
	});

	test('ignores other files, findings beyond the tolerance and lower severities', async () => {
		const result = await matchFindings(
			[expected('a', [10, 10], { severity: 'major' })],
			[finding(10, { path: 'src/other.ts' }), finding(20), finding(10, { severity: 'minor' })],
			{ tolerance: 5 }
		);
		expect(result.matches).toEqual([]);
		expect(result.missed).toEqual(['a']);
		expect(result.unmatched).toEqual([0, 1, 2]);
	});

	test('a judge picks among every unmatched finding on the file, wherever it is', async () => {
		const seen: number[][] = [];
		const result = await matchFindings(
			[expected('a', [10, 10]), expected('b', [50, 50])],
			[finding(10), finding(90), finding(10, { path: 'src/other.ts' })],
			{
				judge: async (problem, candidates) => {
					seen.push(candidates.map((c) => c.startLine));
					return problem.id === 'a' ? 1 : null;
				}
			}
		);
		expect(seen).toEqual([[10, 90], [10]]);
		expect(result.matches).toEqual([{ expected: 'a', finding: 1 }]);
		expect(result.missed).toEqual(['b']);
		expect(result.unmatched).toEqual([0, 2]);
	});

	test('does not ask the judge when the file has no findings', async () => {
		let asked = false;
		const result = await matchFindings([expected('a', [10, 10])], [], {
			judge: async () => {
				asked = true;
				return 0;
			}
		});
		expect(asked).toBe(false);
		expect(result.missed).toEqual(['a']);
	});
});

describe('scoreReview', () => {
	test('scores caught, missed, dropped and extra findings, and the verdict', async () => {
		const score = await scoreReview({
			expected: [expected('a', [10, 10]), expected('b', [20, 20]), expected('c', [40, 40])],
			expectedVerdict: 'request_changes',
			posted: [finding(10), finding(70, { title: 'Unrelated' })],
			dropped: [{ ...finding(20), dropReason: 'Verifier: not a bug' }],
			verdict: 'request_changes'
		});
		expect(score.caught).toEqual(['a']);
		expect(score.missed).toEqual(['b', 'c']);
		expect(score.droppedHits).toEqual([{ expected: 'b', reason: 'Verifier: not a bug' }]);
		expect(score.posted).toBe(2);
		expect(score.extra).toEqual([
			{ path: 'src/math.ts', startLine: 70, severity: 'major', title: 'Unrelated' }
		]);
		expect(score.verdictOk).toBe(true);
	});

	test('leaves the verdict unscored when the case expects none', async () => {
		const score = await scoreReview({ expected: [], posted: [], dropped: [], verdict: 'approve' });
		expect(score.verdictOk).toBeNull();
		expect(score.expected).toBe(0);
	});
});
