import { expect, test } from 'bun:test';
import { reactionChanges, threadsResolvedByPeople } from './resolved-threads';

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

test('reactions are written only where they changed', () => {
	const findings = [
		{ id: 'new-vote', providerCommentId: '1', upvotes: 0, downvotes: 0 },
		{ id: 'same', providerCommentId: '2', upvotes: 2, downvotes: 1 },
		// Read from an Appwrite that does not keep reactions yet.
		{ id: 'never-stored', providerCommentId: '3' },
		{ id: 'unreacted', providerCommentId: '4' },
		{ id: 'body-only', providerCommentId: null },
		{ id: 'no-reactions-read', providerCommentId: '5', upvotes: 1, downvotes: 0 }
	];
	const threads = [
		{ ...thread('1', null, false), reactions: { upvotes: 0, downvotes: 1 } },
		{ ...thread('2', null, false), reactions: { upvotes: 2, downvotes: 1 } },
		{ ...thread('3', null, false), reactions: { upvotes: 1, downvotes: 0 } },
		{ ...thread('4', null, false), reactions: { upvotes: 0, downvotes: 0 } },
		// A provider whose client does not read reactions.
		thread('5', null, false)
	];
	expect(reactionChanges(findings, threads)).toEqual([
		{ id: 'new-vote', upvotes: 0, downvotes: 1 },
		{ id: 'never-stored', upvotes: 1, downvotes: 0 }
	]);
});
