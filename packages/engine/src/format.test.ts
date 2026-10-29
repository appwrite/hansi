import { describe, expect, test } from 'bun:test';
import { UNATTACHED_DROP_REASON } from './findings';
import {
	absolutizeLinks,
	filesTooLargeFromBody,
	filesTooLargeSentence,
	formatBodyFindings,
	formatFileFindingComment,
	formatFindingComment,
	formatReviewBody,
	formatSummaryComment,
	SUMMARY_MARKER,
	type SummaryInput
} from './format';

const base: SummaryInput = {
	repository: 'acme/api',
	headSha: 'abcdef1234567890',
	summary: 'Adds pagination to the items endpoint.',
	tier: 'B',
	tierReason: 'Limited by an open major finding: Off by one',
	verdict: 'request_changes',
	posted: [
		{
			path: 'src/paginate.ts',
			startLine: 3,
			endLine: 4,
			severity: 'major',
			category: 'bug',
			title: 'Off by one | skips the first page',
			body: 'b'
		}
	],
	resolved: [{ path: 'src/a.ts', startLine: 9, title: 'Missing await' }],
	stillOpen: [],
	dropped: [
		{
			path: 'src/b.ts',
			startLine: 1,
			endLine: 1,
			severity: 'info',
			category: 'maintainability',
			title: 'Naming',
			body: 'b',
			dropReason: 'Below minSeverity (minor)'
		}
	],
	walkthrough: [{ path: 'src/paginate.ts', change: 'Switches to 1-based pages.\nAdds pageCount.' }],
	detailsUrl: 'https://hans.example/app/acme/reviews/1',
	mention: '@hans-review'
};

describe('formatSummaryComment', () => {
	const body = formatSummaryComment(base);

	test('starts with the marker and the tier', () => {
		expect(body).toStartWith(`${SUMMARY_MARKER}\n\n## 🟡 Tier B · Needs changes before merging`);
		expect(body).toContain('> Limited by an open major finding: Off by one');
	});

	test('shows the verdict and counts, and links findings to their lines', () => {
		expect(body).toContain('| 🛑 Changes requested | 1 | 1 | 0 |');
		expect(body).toContain(
			'| 🟠 | Off by one \\| skips the first page | [`src/paginate.ts:3`](https://github.com/acme/api/blob/abcdef1234567890/src/paginate.ts#L3-L4) |'
		);
	});

	test('collapses the walkthrough, fixed and filtered findings', () => {
		expect(body).toContain('<summary><b>📂 Walkthrough</b> · 1</summary>');
		expect(body).toContain('| `src/paginate.ts` | Switches to 1-based pages. Adds pageCount. |');
		expect(body).toContain('- ~~Missing await~~ · `src/a.ts:9`');
		expect(body).toContain('| Naming | Below minSeverity (minor) |');
		expect(body).not.toContain('Still open from earlier reviews');
		expect(body).not.toContain('Latest changes');
		expect(body).not.toContain('[!NOTE]');
		expect(body).not.toContain("Couldn't attach to a line");
		expect(body).not.toContain('too large to include in full');
	});

	test('lists findings that could not be attached, apart from other filters', () => {
		const body = formatSummaryComment({
			...base,
			dropped: [
				...base.dropped,
				{
					path: 'src/Videos/Captions.php',
					startLine: 99,
					endLine: 104,
					severity: 'major',
					category: 'bug',
					title: 'Distinguish CMAF-DASH captions',
					body: 'cmaf falls through to the HLS branch.',
					dropReason: 'Lines outside the changed hunks'
				},
				{
					path: 'src/old.php',
					startLine: 4,
					endLine: 4,
					severity: 'minor',
					category: 'bug',
					title: 'Old placement miss',
					body: 'Stored before placement reasons were split.',
					dropReason: UNATTACHED_DROP_REASON
				}
			]
		});
		const section = body.slice(body.indexOf("### Couldn't attach to a line"));
		expect(section).toContain(
			'These findings could not be placed on a changed line, so they were not posted as inline comments.'
		);
		expect(section).toContain(
			'- Distinguish CMAF-DASH captions · [`src/Videos/Captions.php:99`](https://github.com/acme/api/blob/abcdef1234567890/src/Videos/Captions.php#L99-L104) · Lines outside the changed hunks'
		);
		expect(section).toContain(
			'- Old placement miss · [`src/old.php:4`](https://github.com/acme/api/blob/abcdef1234567890/src/old.php#L4) · Not on a changed line'
		);
		expect(section).not.toContain('cmaf falls through');
		expect(body).toContain('| Naming | Below minSeverity (minor) |');
		expect(body).not.toContain('| Distinguish CMAF-DASH captions |');
		expect(body).not.toContain(`| Old placement miss | ${UNATTACHED_DROP_REASON} |`);
	});

	test('says how many changed files did not fit in the prompt', () => {
		const plural = formatSummaryComment({
			...base,
			filesTooLargeForPrompt: { omitted: 3, total: 12 }
		});
		expect(plural).toContain(
			'Adds pagination to the items endpoint.\n\n3 of 12 changed files were too large to include in full.'
		);
		expect(filesTooLargeFromBody(plural)).toEqual({ omitted: 3, total: 12 });

		const singular = filesTooLargeSentence(1, 4);
		expect(singular).toBe('1 of 4 changed files was too large to include in full.');
		expect(filesTooLargeFromBody(singular)).toEqual({ omitted: 1, total: 4 });
		expect(filesTooLargeFromBody('No coverage note here.')).toBeNull();
	});

	test('shows the latest changes and why approval was withheld', () => {
		const withNotes = formatSummaryComment({
			...base,
			verdict: 'comment',
			latestChanges: 'Adds pageCount.',
			approvalWithheld: '@stranger does not have write access to this repository.'
		});
		expect(withNotes).toContain(
			'Adds pagination to the items endpoint.\n\n**Latest changes:** Adds pageCount.'
		);
		expect(withNotes).toContain(
			'> [!NOTE]\n> @stranger does not have write access to this repository.'
		);
	});

	test('notes that newer commits exist without dropping a withheld-approval note', () => {
		const body = formatSummaryComment({
			...base,
			verdict: 'comment',
			headSha: '410aa75000000000000000000000000000000000',
			staleHead:
				'Newer commits exist (`8c9e110`) and will be reviewed. This review is of `410aa75` and does not approve it.',
			approvalWithheld: '@stranger does not have write access to this repository.'
		});
		expect(body).toContain(
			'> [!NOTE]\n> <!-- hans:stale-head --> Newer commits exist (`8c9e110`) and will be reviewed. This review is of `410aa75` and does not approve it.'
		);
		expect(body).toContain('> [!NOTE]\n> @stranger does not have write access to this repository.');
		expect(body).toContain('| 💬 Commented |');
		expect(body).toContain('Reviewed <code>410aa75</code>');
	});

	test('ends with how to interact', () => {
		expect(body).toContain('Reviewed <code>abcdef1</code>');
		expect(body).toContain('<code>@hans-review review</code> to re-run');
	});
});

describe('agent fix prompts', () => {
	test('an inline comment carries a self-contained prompt and keeps the suggestion applicable', () => {
		const comment = formatFindingComment({
			path: 'src/db.ts',
			startLine: 10,
			endLine: 12,
			severity: 'major',
			category: 'bug',
			title: 'Query is not parameterized',
			body: 'The id is interpolated into SQL.',
			suggestion: 'db.query(sql, [id]);\n'
		});
		const suggestion = comment.indexOf('```suggestion\ndb.query(sql, [id]);\n```');
		const prompt = comment.indexOf('<details><summary>Prompt To Fix With AI</summary>');
		expect(suggestion).toBeGreaterThan(-1);
		expect(prompt).toBeGreaterThan(suggestion);
		expect(comment.slice(prompt)).toContain('Path: src/db.ts\nLine: 10-12');
		expect(comment).toContain(
			'For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.'
		);
		expect(comment).toContain('<sub>🟠 Major · bug');
	});

	test('lengthens the prompt fence when the finding contains five backticks', () => {
		const comment = formatFindingComment({
			path: 'a.ts',
			startLine: 4,
			endLine: 4,
			severity: 'minor',
			category: 'testing',
			title: 'Fence',
			body: 'Keep `````this````` inside the prompt.'
		});
		expect(comment).toContain('``````markdown\n');
		expect(comment).toContain('Line: 4\n');
	});

	test('the summary prompt lists new findings and earlier ones that are still open', () => {
		const body = formatSummaryComment({
			...base,
			posted: [{ ...base.posted[0]!, suggestion: 'start = 0;\n' }],
			stillOpen: [
				{
					path: 'src/old.ts',
					startLine: 8,
					endLine: 9,
					title: 'Stale cache',
					body: 'The cache is never invalidated.',
					suggestion: 'cache.invalidate();\n',
					severity: 'minor'
				}
			]
		});
		const prompt = body.slice(body.indexOf('<details><summary>Fix with agent prompt</summary>'));
		expect(prompt).toContain(
			'### Issue 1\nsrc/paginate.ts:3-4\n**Off by one | skips the first page**\n\nb\n\n```suggestion\nstart = 0;\n```'
		);
		expect(prompt).toContain(
			'### Issue 2\nsrc/old.ts:8-9\n**Stale cache**\n\nThe cache is never invalidated.\n\n```suggestion\ncache.invalidate();\n```'
		);
		expect(prompt).toContain(
			'For each issue above, determine whether it is valid and should be fixed. If so, fix it directly.'
		);
	});

	test('omits the summary prompt when nothing is open', () => {
		const body = formatSummaryComment({ ...base, posted: [] });
		expect(body).not.toContain('Fix with agent prompt');
		expect(body).not.toContain('Prompt To Fix With AI');
	});
});

const REPO = 'appwrite/appwrite';
const SHA = '999c0d1';
const blob = (path: string) => `https://github.com/${REPO}/blob/${SHA}/${path}`;

describe('absolutizeLinks', () => {
	test('rewrites relative repo paths, ./ prefixes, and line anchors', () => {
		const body = [
			'See [ConfigTest.php:148–163](packages/config/tests/ConfigTest.php#L148) and [lines 286–307](packages/config/tests/ConfigTest.php#L286).',
			'[packages/config/README.md:104](./packages/config/README.md#L104)',
			'[README.md:122–135](packages/config/README.md#L122-L135)',
			'[GitHub.php](packages/vcs/src/Adapter/Git/GitHub.php#L772-L779)',
			'[GitHubTest.php](<./packages/vcs/tests/GitHubTest.php#L282-L343>)',
			'[range](./src/app.ts#L10-L20)'
		].join('\n');
		const linked = absolutizeLinks(body, REPO, SHA);
		expect(linked).toContain(
			`[ConfigTest.php:148–163](${blob('packages/config/tests/ConfigTest.php')}#L148)`
		);
		expect(linked).toContain(
			`[lines 286–307](${blob('packages/config/tests/ConfigTest.php')}#L286)`
		);
		expect(linked).toContain(
			`[packages/config/README.md:104](${blob('packages/config/README.md')}#L104)`
		);
		expect(linked).toContain(`[README.md:122–135](${blob('packages/config/README.md')}#L122-L135)`);
		expect(linked).toContain(
			`[GitHub.php](${blob('packages/vcs/src/Adapter/Git/GitHub.php')}#L772-L779)`
		);
		expect(linked).toContain(
			`[GitHubTest.php](${blob('packages/vcs/tests/GitHubTest.php')}#L282-L343)`
		);
		expect(linked).toContain(`[range](${blob('src/app.ts')}#L10-L20)`);
		expect(linked).not.toContain('](packages/');
		expect(linked).not.toContain('](./');
	});

	test('leaves absolute, external, anchor, and root-absolute links alone', () => {
		const body = [
			`[blob](${blob('README.md')}#L1)`,
			'[docs](https://example.com/packages/config/README.md#L10-L20)',
			'[mail](mailto:dev@example.com)',
			'[section](#discussion)',
			'[root](/appwrite/appwrite/blob/x)',
			'[issue](../issues/72)'
		].join(' ');
		expect(absolutizeLinks(body, REPO, SHA)).toBe(body);
	});

	test('rewrites paths that contain parentheses', () => {
		const body = [
			'[file](src/foo(bar).ts#L10-L20)',
			'[both](./src/foo(bar)(baz).ts)',
			'[angled](<src/foo(bar).ts#L2>)',
			'[titled](src/foo(bar).ts "the helper")',
			'[docs](https://example.com/foo(bar).ts#L10-L20)'
		].join('\n');
		const linked = absolutizeLinks(body, REPO, SHA);
		expect(linked).toContain(`[file](${blob('src/foo%28bar%29.ts')}#L10-L20)`);
		expect(linked).toContain(`[both](${blob('src/foo%28bar%29%28baz%29.ts')})`);
		expect(linked).toContain(`[angled](${blob('src/foo%28bar%29.ts')}#L2)`);
		expect(linked).toContain(`[titled](${blob('src/foo%28bar%29.ts')} "the helper")`);
		expect(linked).toContain('[docs](https://example.com/foo(bar).ts#L10-L20)');
		expect(linked).not.toContain('](src/foo(bar');
	});

	test('keeps a link title and does not rewrite code or images', () => {
		const body = [
			'[file](./src/a.ts#L10-L20 "the helper")',
			'![diagram](docs/diagram.png)',
			'Mention `[file](./src/a.ts#L1)` in prose, then [open it](src/a.ts#L2).',
			'```ts',
			'const sample = "[file](packages/foo.ts#L10-L20)";',
			'```'
		].join('\n');
		const linked = absolutizeLinks(body, REPO, SHA);
		expect(linked).toContain(`[file](${blob('src/a.ts')}#L10-L20 "the helper")`);
		expect(linked).toContain('![diagram](docs/diagram.png)');
		expect(linked).toContain('`[file](./src/a.ts#L1)`');
		expect(linked).toContain(`[open it](${blob('src/a.ts')}#L2)`);
		expect(linked).toContain('const sample = "[file](packages/foo.ts#L10-L20)";');
	});
});

test('posted summaries and finding comments rewrite relative file links', () => {
	const summary = formatSummaryComment({
		...base,
		summary: 'See [paginate](./src/paginate.ts#L3-L4) for the loop.'
	});
	expect(summary).toContain(
		'[paginate](https://github.com/acme/api/blob/abcdef1234567890/src/paginate.ts#L3-L4)'
	);
	expect(summary).toContain(
		'[`src/paginate.ts:3`](https://github.com/acme/api/blob/abcdef1234567890/src/paginate.ts#L3-L4)'
	);

	const comment = formatFindingComment(
		{
			path: 'src/db.ts',
			startLine: 10,
			endLine: 12,
			severity: 'major',
			category: 'bug',
			title: 'Query is not parameterized',
			body: 'See [the caller](src/caller.ts#L10-L20).',
			suggestion: 'db.query("[keep](src/a.ts)", [id]);\n'
		},
		{ repository: 'acme/api', headSha: 'abcdef1234567890' }
	);
	expect(comment).toContain(
		'[the caller](https://github.com/acme/api/blob/abcdef1234567890/src/caller.ts#L10-L20)'
	);
	expect(comment).toContain('db.query("[keep](src/a.ts)", [id]);');
});

test('the review body is one line that points to the summary', () => {
	expect(
		formatReviewBody({
			tier: 'B',
			verdict: 'request_changes',
			blocking: 1,
			summaryUrl: 'https://x'
		})
	).toBe('🟡 **Tier B** · 1 blocking finding to address. [Summary](https://x)');
	expect(formatReviewBody({ tier: 'S', verdict: 'approve', blocking: 0 })).toBe(
		'🟢 **Tier S** · Looks good to merge.'
	);
	expect(
		formatReviewBody({
			tier: 'S',
			verdict: 'comment',
			blocking: 0,
			comments: 0,
			summaryUrl: 'https://x'
		})
	).toBe('🟢 **Tier S** · Looks good to merge. [Summary](https://x)');
	expect(
		formatReviewBody({
			tier: 'A',
			verdict: 'comment',
			blocking: 0,
			comments: 1,
			summaryUrl: 'https://x'
		})
	).toBe('🔵 **Tier A** · See the inline comments. [Summary](https://x)');
	expect(
		formatReviewBody({ tier: 'A', verdict: 'comment', blocking: 0, comments: 0, inBody: 2 })
	).toBe('🔵 **Tier A** · See the findings below.');
	expect(
		formatReviewBody({ tier: 'S', verdict: 'comment', blocking: 0, comments: 0, inBody: 1 })
	).toBe('🟢 **Tier S** · See the findings below.');
});

test('findings GitHub would not take inline are listed with a note', () => {
	const finding = {
		path: 'src/services/project.ts',
		startLine: 77,
		endLine: 77,
		severity: 'minor' as const,
		category: 'bug' as const,
		title: 'Keep project onboarding object-shaped',
		body: 'b'
	};
	expect(formatBodyFindings([], { repository: 'acme/api', headSha: 'abc' })).toBe('');
	const body = formatBodyFindings([finding], { repository: 'acme/api', headSha: 'abc' });
	expect(body).toStartWith("> [!NOTE]\n> GitHub does not show the diff for this finding's lines");
	expect(body).toContain('#### `src/services/project.ts:77`');
	expect(body).toContain('**Keep project onboarding object-shaped**');
});

test('a finding on a file without a diff names its lines in the file comment', () => {
	const finding = {
		path: 'dashboards/Edge/inbound-email.json',
		startLine: 394,
		endLine: 394,
		severity: 'minor' as const,
		category: 'bug' as const,
		title: 'Keep range-based rate windows above 2m',
		body: 'b'
	};
	const body = formatFileFindingComment(finding);
	expect(body).toStartWith("**Line 394** · GitHub does not show this file's diff");
	expect(body).toContain('**Keep range-based rate windows above 2m**');
	expect(formatFileFindingComment({ ...finding, startLine: 390 })).toStartWith('**Lines 390-394**');
});
