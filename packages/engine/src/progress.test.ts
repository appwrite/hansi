import { expect, test } from 'bun:test';
import { SUMMARY_MARKER } from './format';
import type { Log } from './context';
import {
	createReviewProgress,
	hasReviewSummary,
	phaseFromEvent,
	statusBlock,
	statusBlockOf,
	withStatusBlock,
	withoutStatusBlock,
	type ProgressTarget
} from './progress';

const sha = 'abcdef1234567890';
const summary = `${SUMMARY_MARKER}\n\n## Code review\n\n| Commit | Status | Tier | Verdict |`;
const block = (previous = false) =>
	statusBlock(
		{ kind: 'running', phase: { kind: 'reviewing', files: 3 } },
		{ headSha: sha, mention: '@hansi', previous, detailsUrl: 'https://hansi.test/r/1' }
	);

test('trace events move the review into its phases', () => {
	expect(
		phaseFromEvent({ type: 'files.prompt', data: { shown: ['a.ts', 'b.ts'], notShown: ['c.ts'] } })
	).toEqual({ kind: 'reviewing', files: 3 });
	expect(phaseFromEvent({ type: 'review.submitted', data: { findings: 2 } })).toEqual({
		kind: 'verifying',
		findings: 2
	});
	// Nothing to verify: the review goes straight to posting.
	expect(phaseFromEvent({ type: 'review.submitted', data: { findings: 0 } })).toBeNull();
	expect(phaseFromEvent({ type: 'tool.read_file', data: {} })).toBeNull();
});

test('the status block is the progress row of the Sites and Functions comments', () => {
	expect(block(true)).toBe(
		[
			'<!-- appwrite-hansi:status -->',
			'',
			'| Commit | Status | Details |',
			'| :- | :- | :- |',
			'| `abcdef1` | _Reviewing 3 files_ | [Follow along](https://hansi.test/r/1) |',
			'',
			'<sub>The summary below is from the previous review.</sub>',
			'',
			'<!-- /appwrite-hansi:status -->'
		].join('\n')
	);
	const failed = statusBlock(
		{ kind: 'failed' },
		{ headSha: sha, mention: '@hansi', previous: false }
	);
	expect(failed).toContain('| `abcdef1` | _Failed_ |');
	expect(failed).toContain('<code>@hansi review</code> to try again');
	expect(failed).not.toContain('Follow along');
});

test('the status row shows the animated image while running, and the state images after', () => {
	const images = 'https://cloud.appwrite.io';
	const running = statusBlock(
		{ kind: 'running', phase: { kind: 'verifying', findings: 2 } },
		{ headSha: sha, mention: '@hansi', previous: false, images }
	);
	expect(running).toContain(
		'<picture><source media="(prefers-color-scheme: dark)" srcset="https://cloud.appwrite.io/images/vcs/status-building-dark.gif"><img alt="Verifying 2 possible findings" width="85" align="absmiddle" src="https://cloud.appwrite.io/images/vcs/status-building-light.gif"></picture> _Verifying 2 possible findings_'
	);
	const image = (status: Parameters<typeof statusBlock>[0]) =>
		statusBlock(status, { headSha: sha, mention: '@hansi', previous: true, images }).match(
			/status-(\w+)-light\.(\w+)/
		)?.[0];
	expect(image({ kind: 'retrying' })).toBe('status-waiting-light.png');
	expect(image({ kind: 'failed' })).toBe('status-failed-light.png');
	// A skip has no state image of its own.
	expect(image({ kind: 'skipped', reason: 'Nothing to review' })).toBeUndefined();
});

test('a first review starts the summary with the status block alone', () => {
	const body = withStatusBlock(null, block());
	expect(body).toBe(`${SUMMARY_MARKER}\n\n${block()}`);
	expect(hasReviewSummary(body)).toBe(false);
	expect(statusBlockOf(body)).toBe(block());
});

test('a later review puts the status above the previous summary and removes it cleanly', () => {
	const body = withStatusBlock(summary, block(true));
	expect(body.startsWith(`${SUMMARY_MARKER}\n\n${block(true)}\n\n## Code review`)).toBe(true);
	expect(hasReviewSummary(body)).toBe(true);
	expect(withoutStatusBlock(body)).toBe(summary);
	// Replacing the block keeps one, not two.
	const again = withStatusBlock(body, block(false));
	expect(again.match(/<!-- appwrite-hansi:status -->/g)).toHaveLength(1);
	expect(withStatusBlock(body, null)).toBe(summary);
});

const silent = { warn: () => {} } as unknown as Log;

function fakeGitHub(initial: string | null) {
	const state = {
		comment: initial === null ? null : { id: '1', body: initial },
		checkRun: [] as string[],
		writes: 0
	};
	const target: ProgressTarget = {
		headSha: sha,
		mention: '@hansi',
		log: silent,
		updateCheckRun: async (output) => {
			state.checkRun.push(output.title);
		},
		readSummary: async () => state.comment,
		writeSummary: async (id, body) => {
			state.writes++;
			state.comment = { id: id ?? '2', body };
		}
	};
	return { state, target };
}

test('progress follows the phases on the check run and the summary', async () => {
	const { state, target } = fakeGitHub(summary);
	const progress = createReviewProgress(target);
	progress.phase({ kind: 'reviewing', files: 0 });
	progress.onEvent({ type: 'files.prompt', data: { shown: ['a.ts'], notShown: [] } });
	progress.onEvent({ type: 'files.prompt', data: { shown: ['a.ts'], notShown: [] } });
	progress.onEvent({ type: 'review.submitted', data: { findings: 1 } });
	progress.phase({ kind: 'publishing' });
	await progress.close();
	expect(state.checkRun).toEqual([
		'Reviewing the changes',
		'Reviewing 1 file',
		'Verifying 1 possible finding',
		'Posting the review'
	]);
	expect(state.writes).toBe(3);
	expect(state.comment?.body).toContain('_Verifying 1 possible finding_');
	expect(state.comment?.body).toContain('The summary below is from the previous review.');
	// Nothing lands after close, so the final summary cannot be overwritten.
	progress.phase({ kind: 'reviewing', files: 9 });
	await Promise.resolve();
	expect(state.checkRun).toHaveLength(4);
});

test('a failed review never leaves the summary saying it is running', async () => {
	const { state, target } = fakeGitHub(summary);
	const progress = createReviewProgress(target);
	progress.phase({ kind: 'reviewing', files: 2 });
	await progress.settle({ kind: 'failed' });
	expect(state.comment?.body).not.toContain('_Reviewing 2 files_');
	expect(state.comment?.body).toContain('_Failed_');
	expect(state.comment?.body).toContain('could not finish this review');
	expect(withoutStatusBlock(state.comment!.body)).toBe(summary);
});

test('a failure before the summary was touched does not create a comment', async () => {
	const { state, target } = fakeGitHub(null);
	const progress = createReviewProgress(target);
	progress.phase({ kind: 'preparing' });
	await progress.settle({ kind: 'failed' });
	expect(state.comment).toBeNull();
});

test('a retry clears the status an earlier attempt left behind', async () => {
	const { state, target } = fakeGitHub(withStatusBlock(summary, block(true)));
	const progress = createReviewProgress(target);
	await progress.settle({ kind: 'retrying' });
	expect(state.comment?.body).toContain('was interrupted');
	expect(state.comment?.body).toContain('_Interrupted, retrying_');
	expect(state.comment?.body).not.toContain('_Reviewing 3 files_');
});

test('a skip removes the status, or explains itself when there is no earlier summary', async () => {
	const later = fakeGitHub(summary);
	const one = createReviewProgress(later.target);
	one.phase({ kind: 'reviewing', files: 1 });
	await one.settle({ kind: 'skipped', reason: 'No new reviewable changes since the last review' });
	expect(later.state.comment?.body).toBe(summary);

	const first = fakeGitHub(null);
	const two = createReviewProgress(first.target);
	two.phase({ kind: 'reviewing', files: 1 });
	await two.settle({ kind: 'skipped', reason: 'No reviewable changes' });
	expect(first.state.comment?.body).toContain('| `abcdef1` | _Skipped_ |');
	expect(first.state.comment?.body).toContain('<sub>No reviewable changes</sub>');
});

test('a GitHub error while reporting progress does not fail the review', async () => {
	const { target } = fakeGitHub(summary);
	const progress = createReviewProgress({
		...target,
		updateCheckRun: async () => {
			throw new Error('502');
		}
	});
	progress.phase({ kind: 'preparing' });
	await expect(progress.close()).resolves.toBeUndefined();
});
