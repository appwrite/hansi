import { expect, test } from 'bun:test';
import type { FindingRecord } from './results';
import { chatFinding, chatReplyFields, findingsNamedIn, openBodyFindings } from './chat-finding';

const record = (finding: Partial<FindingRecord> & { id: string }): FindingRecord => ({
	reviewId: 'review-1',
	path: 'tests/unit/General/ScopesTest.php',
	startLine: 33,
	endLine: 36,
	severity: 'minor',
	category: 'testing',
	title: 'Keep config-contract checks outside the restricted unit tier',
	body: 'AGENTS.md limits tests/unit to local src libraries.',
	suggestion: null,
	status: 'posted',
	dropReason: null,
	providerCommentId: 4204630028,
	createdAt: '2026-09-01T00:00:00.000Z',
	...finding
});

const inline = record({ id: 'finding-1' });

test('a thread reply loads the finding severity, category, and title', () => {
	const finding = chatFinding([inline], 4204630028);
	expect(finding).toEqual({
		id: 'finding-1',
		severity: 'minor',
		category: 'testing',
		title: 'Keep config-contract checks outside the restricted unit tier'
	});
	expect(chatFinding([inline], 1)).toBeUndefined();
	expect(chatFinding([inline], undefined)).toBeUndefined();
});

test('chat reply fields pass the association and the finding through to runChat', () => {
	const finding = chatFinding([inline], 4204630028);
	expect(chatReplyFields({ authorAssociation: 'MEMBER' }, finding)).toEqual({
		authorAssociation: 'MEMBER',
		finding: {
			severity: 'minor',
			category: 'testing',
			title: 'Keep config-contract checks outside the restricted unit tier'
		}
	});
	expect(chatReplyFields({ authorAssociation: 'NONE' }, undefined)).toEqual({
		authorAssociation: 'NONE'
	});
	// A job queued before association was stored stays untrusted.
	expect(chatReplyFields({}, finding).authorAssociation).toBe('');
});

const rateWindow = {
	id: 'finding-body',
	severity: 'minor' as const,
	category: 'bug',
	title: 'Keep range-based rate windows above 2m',
	path: 'dashboards/Edge/inbound-email.json',
	startLine: 394,
	endLine: 394
};

test('open findings listed in the review body are the posted ones without a thread', () => {
	const body = record({ ...rateWindow, body: 'p95 goes blank.', providerCommentId: null });
	const dismissed = record({
		...rateWindow,
		id: 'finding-body-dismissed',
		body: 'p95 goes blank.',
		status: 'dismissed',
		providerCommentId: null
	});
	// The inline finding has a thread and is answered there.
	expect(openBodyFindings([inline, body, dismissed]).map((f) => f.id)).toEqual(['finding-body']);
	expect(openBodyFindings([inline])).toEqual([]);
});

test('a conversation comment names a body finding by its title or line', () => {
	const pushback =
		'On the 🟡 "Keep range-based rate windows above 2m" finding: I\'m keeping it as is.';
	expect(findingsNamedIn(pushback, [rateWindow], { mentioned: false })).toEqual([rateWindow]);
	expect(
		findingsNamedIn('`dashboards/Edge/inbound-email.json:394` is intended', [rateWindow], {
			mentioned: false
		})
	).toEqual([rateWindow]);
	expect(findingsNamedIn('Thanks, merging now.', [rateWindow], { mentioned: false })).toEqual([]);
});

test('a mention that names no finding is about the only open one', () => {
	const other = { ...rateWindow, id: 'finding-other', title: 'Label the ingress panel' };
	const again = { ...rateWindow, id: 'finding-again' };
	expect(
		findingsNamedIn('@hansi-codes this does not apply', [rateWindow], { mentioned: true })
	).toEqual([rateWindow]);
	// The same finding from an earlier review counts as one.
	expect(
		findingsNamedIn('@hansi-codes this does not apply', [rateWindow, again], { mentioned: true })
	).toEqual([rateWindow, again]);
	expect(
		findingsNamedIn('@hansi-codes this does not apply', [rateWindow, other], { mentioned: true })
	).toEqual([]);
	expect(
		findingsNamedIn(
			'Keep range-based rate windows above 2m and Label the ingress panel',
			[rateWindow, other],
			{ mentioned: false }
		)
	).toEqual([]);
});
