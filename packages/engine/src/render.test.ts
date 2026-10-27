import { describe, expect, test } from 'bun:test';
import { defaultConfig } from './config';
import type { ReviewFinding } from './findings';
import { renderFinding, renderReviewBody } from './render';
import type { ReviewResult } from './review';

const finding: ReviewFinding = {
	path: 'a.ts',
	startLine: 1,
	endLine: 2,
	severity: 'minor',
	category: 'bug',
	title: 'Off by one',
	body: 'The loop skips the last item.'
};

const result = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
	summary: 'Adds a loop.',
	walkthrough: [{ path: 'a.ts', summary: 'New | loop' }],
	findings: [],
	dropped: [],
	resolved: [],
	tier: 'S',
	tierReason: '',
	verdict: 'approve',
	partial: false,
	notShown: [],
	...overrides
});

describe('renderFinding', () => {
	test('shows the title, body and grade', () => {
		const body = renderFinding(finding);
		expect(body).toStartWith('**Off by one**\n\nThe loop skips the last item.');
		expect(body).toEndWith('<sub>🟡 Minor · bug</sub>');
	});

	test('fences a suggestion so code with backticks cannot close it', () => {
		const body = renderFinding({ ...finding, suggestion: 'const s = ```;' });
		expect(body).toContain('````suggestion\nconst s = ```;\n````');
	});
});

describe('renderReviewBody', () => {
	test('leads with the tier and summary', () => {
		const body = renderReviewBody(result(), { config: defaultConfig });
		expect(body).toStartWith('## 🟢 Tier S · Ready to merge\n\nAdds a loop.');
		expect(body).toContain('| `a.ts` | New \\| loop |');
	});

	test('explains a withheld approval, skipped files and broken settings', () => {
		const body = renderReviewBody(
			result({
				tier: 'A',
				tierReason: 'Limited by an open minor finding: Off by one',
				verdict: 'comment',
				findings: [finding],
				partial: true,
				notShown: [{ path: 'bun.lock', reason: 'ignored' }],
				dropped: [{ ...finding, title: 'Another', reason: 'Over the comment limit' }]
			}),
			{ config: defaultConfig, configErrors: ['Not valid JSON'] }
		);
		expect(body).toContain('> Limited by an open minor finding: Off by one');
		expect(body).toContain('Not approving while a bug finding is open: Off by one.');
		expect(body).toContain('- a.ts:1 Another');
		expect(body).toContain('does not approve');
		expect(body).toContain('- `bun.lock` (ignored)');
		expect(body).toContain('- Not valid JSON');
	});
});
