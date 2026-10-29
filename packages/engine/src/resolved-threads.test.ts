import { expect, test } from 'bun:test';
import { threadsResolvedByPeople } from './resolved-threads';

const thread = (rootCommentId: number, resolvedBy: string | null, isResolved = true) => ({
	id: `T${rootCommentId}`,
	isResolved,
	resolvedBy,
	rootCommentId
});

test('finds open findings whose thread a person resolved', () => {
	const findings = [
		{ id: 'passkeys', githubCommentId: 1 },
		{ id: 'fixed-by-hansi', githubCommentId: 2 },
		{ id: 'still-open', githubCommentId: 3 },
		{ id: 'no-thread', githubCommentId: 4 }
	];
	const threads = [
		thread(1, 'lohanidamodar'),
		thread(2, 'hansi-codes[bot]'),
		thread(3, null, false),
		thread(9, 'someone')
	];
	expect(threadsResolvedByPeople(findings, threads, 'Hansi-Codes[bot]')).toEqual([
		{ findingId: 'passkeys', resolvedBy: 'lohanidamodar' }
	]);
});

test('a resolved thread whose resolver GitHub no longer knows is skipped', () => {
	expect(
		threadsResolvedByPeople([{ id: 'a', githubCommentId: 1 }], [thread(1, null)], 'x[bot]')
	).toEqual([]);
});
