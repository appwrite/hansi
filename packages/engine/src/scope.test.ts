import { describe, expect, test } from 'bun:test';
import { SUMMARY_MARKER } from './format';
import { reviewMarkerFor, scopeToRepository, summaryMarkerFor } from './scope';
import { MemoryGitHub } from './testing';

// Two Appwrite projects reviewing one repository share the GitHub App: each sees only its own
// summary comment, check run and change requests.

function setup() {
	const github = new MemoryGitHub({
		number: 7,
		title: 'Divide',
		body: '',
		author: 'octocat',
		authorAssociation: 'MEMBER',
		draft: false,
		state: 'open',
		merged: false,
		baseRef: 'main',
		baseSha: 'base',
		headSha: 'head',
		cloneUrl: ''
	});
	const connection = { github, app: github.app };
	return {
		github,
		a: scopeToRepository(connection, 'repoA').github,
		b: scopeToRepository(connection, 'repoB').github
	};
}

describe('scopeToRepository', () => {
	test('each repository row keeps its own summary comment', async () => {
		const { github, a, b } = setup();

		await a.upsertMarkedComment(7, SUMMARY_MARKER, `${SUMMARY_MARKER}\n\nA's summary`);
		await b.upsertMarkedComment(7, SUMMARY_MARKER, `${SUMMARY_MARKER}\n\nB's summary`);
		await a.upsertMarkedComment(7, SUMMARY_MARKER, `${SUMMARY_MARKER}\n\nA again`);

		expect(github.issueComments.map((c) => c.body)).toEqual([
			`${summaryMarkerFor('repoA')}\n\nA again`,
			`${summaryMarkerFor('repoB')}\n\nB's summary`
		]);
		// The engine reads its summary back with the marker it wrote.
		expect((await b.getMarkedComment(7, SUMMARY_MARKER))?.body).toBe(
			`${SUMMARY_MARKER}\n\nB's summary`
		);
	});

	test('a summary comment from before keyed markers is taken over, once', async () => {
		const { github, a, b } = setup();
		await github.createIssueComment(7, `${SUMMARY_MARKER}\n\nold`);
		const legacy = github.issueComments[0]!.id;

		const found = await a.getMarkedComment(7, SUMMARY_MARKER);
		expect(found?.id).toBe(legacy);
		// Progress edits go through updateIssueComment with the engine's marker.
		await a.updateIssueComment(legacy, `${SUMMARY_MARKER}\n\nnew`);
		expect(github.issueComments[0]?.body).toBe(`${summaryMarkerFor('repoA')}\n\nnew`);

		expect(await b.getMarkedComment(7, SUMMARY_MARKER)).toBeNull();
		await b.upsertMarkedComment(7, SUMMARY_MARKER, `${SUMMARY_MARKER}\n\nB`);
		expect(github.issueComments).toHaveLength(2);
	});

	test('a change request is withdrawn only by the row that made it', async () => {
		const { github, a, b } = setup();
		await github.createReview({
			pullNumber: 7,
			commitId: 'head',
			body: 'from before keyed reviews',
			comments: [],
			event: 'REQUEST_CHANGES'
		});
		await a.createReview({
			pullNumber: 7,
			commitId: 'head',
			body: 'A',
			comments: [],
			event: 'REQUEST_CHANGES'
		});
		expect(github.reviews[1]?.body).toBe(`A\n\n${reviewMarkerFor('repoA')}`);

		await b.dismissChangeRequests(7, { botLogin: 'hansi[bot]', message: 'ok' });
		expect(github.reviews.map((r) => r.state)).toEqual(['DISMISSED', 'CHANGES_REQUESTED']);

		await a.dismissChangeRequests(7, { botLogin: 'hansi[bot]', message: 'ok' });
		expect(github.reviews[1]?.state).toBe('DISMISSED');
	});

	test('check runs carry the repository row', async () => {
		const { github, a } = setup();
		await a.startCheckRun({ headSha: 'head', name: 'Hansi' });
		expect(github.checkRuns[0]?.externalId).toBe('repoA');
	});

	test('everything else reaches the client unchanged', async () => {
		const { github, a } = setup();
		await a.createIssueComment(7, 'hello');
		expect(github.issueComments[0]?.body).toBe('hello');
		expect((await a.getPullRequest(7)).number).toBe(7);
	});
});
