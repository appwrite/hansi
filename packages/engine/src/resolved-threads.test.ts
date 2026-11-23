import { expect, test } from 'bun:test';
import type { Log } from './context';
import { threadsResolvedByPeople, withThreadReplies } from './resolved-threads';
import { MemoryGitHub } from './testing';

const thread = (rootCommentId: string, resolvedBy: string | null, isResolved = true) => ({
	id: `T${rootCommentId}`,
	isResolved,
	resolvedBy,
	rootCommentId
});

test('finds open findings whose thread a person resolved', () => {
	const findings = [
		{ id: 'passkeys', providerCommentId: '1' },
		{ id: 'fixed-by-hansi', providerCommentId: '2' },
		{ id: 'still-open', providerCommentId: '3' },
		{ id: 'no-thread', providerCommentId: '4' }
	];
	const threads = [
		thread('1', 'lohanidamodar'),
		thread('2', 'hansi-codes[bot]'),
		thread('3', null, false),
		thread('9', 'someone')
	];
	expect(threadsResolvedByPeople(findings, threads, 'Hansi-Codes[bot]')).toEqual([
		{ findingId: 'passkeys', resolvedBy: 'lohanidamodar' }
	]);
});

test('a resolved thread whose resolver GitHub no longer knows is skipped', () => {
	expect(
		threadsResolvedByPeople([{ id: 'a', providerCommentId: '1' }], [thread('1', null)], 'x[bot]')
	).toEqual([]);
});

test('reads the replies people with write access left on open findings', async () => {
	const github = new MemoryGitHub({
		number: 7,
		title: 'Collector',
		body: '',
		author: 'octocat',
		authorAssociation: 'MEMBER',
		botOnOwnBranch: false,
		draft: false,
		state: 'open',
		merged: false,
		baseRef: 'main',
		baseSha: 'a',
		headSha: 'b',
		cloneUrl: ''
	});
	github.writers.add('octocat');
	const comment = (id: string, author: string, body: string, inReplyToId?: string) =>
		github.reviewComments.push({ id, author, body, isBot: author.endsWith('[bot]'), inReplyToId });
	comment('1', 'hansi[bot]', 'Use the node name');
	comment('2', 'octocat', 'The chart already sets HOSTNAME to the node name.', '1');
	comment('3', 'drive-by', 'Agreed, not a bug.', '1');
	comment('4', 'hansi[bot]', 'Thanks.', '1');
	comment('5', 'hansi[bot]', 'Another finding');

	const findings = [
		{ id: 'node-name', providerCommentId: '1' },
		{ id: 'unanswered', providerCommentId: '5' },
		{ id: 'body-only', providerCommentId: null }
	];
	const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Log;
	const read = await withThreadReplies(
		{ github, app: github.app },
		{ projectId: 'p', repositoryId: 'r', pullNumber: 7 },
		findings,
		log
	);

	expect(read).toEqual([
		{
			id: 'node-name',
			providerCommentId: '1',
			replies: [{ author: 'octocat', body: 'The chart already sets HOSTNAME to the node name.' }]
		},
		{ id: 'unanswered', providerCommentId: '5' },
		{ id: 'body-only', providerCommentId: null }
	]);
});
