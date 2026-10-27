import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChatJob } from './chat-job';
import { git } from './git';
import type { PullRequest } from './github';
import type { ChatJob } from './jobs';
import type { SandboxClient } from './sandbox';
import { MemoryGitHub, MemoryResultsSink, scriptedModel } from './testing';

let root: string;
let remote: string;
let baseSha: string;
let headSha: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'hansi-chat-'));
	remote = join(root, 'origin.git');
	const work = join(root, 'work');
	await mkdir(work);
	await git(['init', '--quiet', '--bare', remote], { cwd: root });
	await git(['config', 'uploadpack.allowFilter', 'true'], { cwd: remote });
	await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: remote });

	const run = (args: string[]) => git(args, { cwd: work });
	await run(['init', '--quiet', '-b', 'main']);
	await run(['config', 'user.email', 'test@example.com']);
	await run(['config', 'user.name', 'Test']);
	const lines = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
	await writeFile(join(work, 'app.ts'), lines.join('\n') + '\n');
	await run(['add', '-A']);
	await run(['commit', '--quiet', '-m', 'base']);
	baseSha = (await run(['rev-parse', 'HEAD'])).trim();

	lines[4] = 'const v5 = 500;';
	await writeFile(join(work, 'app.ts'), lines.join('\n') + '\n');
	await run(['add', '-A']);
	await run(['commit', '--quiet', '-m', 'head']);
	headSha = (await run(['rev-parse', 'HEAD'])).trim();
	await run(['push', '--quiet', remote, 'main']);
});

afterAll(() => rm(root, { recursive: true, force: true }));

const pullRequest = (): PullRequest => ({
	number: 7,
	title: 'Bump v5',
	body: '',
	author: 'octocat',
	authorAssociation: 'CONTRIBUTOR',
	draft: false,
	state: 'open',
	merged: false,
	base: { ref: 'main', sha: baseSha },
	head: { ref: 'bump', sha: headSha },
	url: 'https://github.com/acme/app/pull/7'
});

const job = (
	comment: Partial<ChatJob['comment']> = {},
	overrides: Partial<ChatJob> = {}
): ChatJob => ({
	type: 'chat',
	repository: {
		projectId: 'project-1',
		projectInternalId: '1',
		repositoryId: 'repo-1',
		installationId: 'installation-1',
		providerInstallationId: '42',
		providerRepositoryId: '99',
		owner: 'acme',
		name: 'app'
	},
	pullNumber: 7,
	comment: {
		id: 1,
		kind: 'issue',
		author: 'maintainer',
		authorAssociation: 'MEMBER',
		url: 'https://github.com/acme/app/pull/7#issuecomment-1',
		...comment
	},
	...overrides
});

const unusedSandboxes: SandboxClient = {
	create: () => Promise.reject(new Error('no sandboxes in chat'))
};

function setup() {
	const github = new MemoryGitHub(pullRequest(), [], { url: `file://${remote}` });
	return {
		github,
		context: { github, results: new MemoryResultsSink(), sandboxes: unusedSandboxes }
	};
}

const answer = (body: string) =>
	scriptedModel([{ calls: [{ tool: 'submit_reply', input: { body } }] }]);

/** A finding the reviewer posted, as the first comment of a review thread. */
function postFinding(github: MemoryGitHub) {
	github.reviews.push({
		pullNumber: 7,
		review: {
			commitId: headSha,
			event: 'COMMENT',
			body: 'Tier B\n\n<!-- hansi:review review-1 -->',
			comments: []
		}
	});
	github.reviewComments.push({
		id: 10,
		reviewId: 1,
		path: 'app.ts',
		line: 5,
		body: '**v5 overflows**',
		author: 'hansi[bot]',
		bot: true,
		url: 'memory://comment/10'
	});
}

function reply(id: number, body: string, author = 'octocat') {
	return {
		id,
		path: 'app.ts',
		line: 5,
		body,
		author,
		bot: false,
		inReplyToId: 10,
		url: `memory://comment/${id}`
	};
}

describe('runChatJob', () => {
	test('answers a question on the conversation, once', async () => {
		const { github, context } = setup();
		github.issueComments.push(
			{ id: 1, body: '@hansi why 500?', author: 'maintainer', bot: false, url: 'memory://1' },
			{ id: 2, body: 'Unrelated.', author: 'someone', bot: false, url: 'memory://2' }
		);
		const model = answer('Because `app.ts:5` says so.');

		await runChatJob(job(), context, { model });
		await runChatJob(job(), context, { model: scriptedModel([]) });

		const posted = github.issueComments.filter((c) => c.bot);
		expect(posted).toHaveLength(1);
		expect(posted[0]!.body).toBe(
			'@maintainer Because `app.ts:5` says so.\n\n<!-- hansi:chat 1 -->'
		);
		expect(github.reactions).toEqual([{ comment: { id: 1, kind: 'issue' }, reaction: 'eyes' }]);
		const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
		expect(prompt).toContain('why 500?');
		expect(prompt).not.toContain('Unrelated.');
		expect(prompt).toContain('const v5 = 500;');
	});

	test("answers a reply to its own finding without a mention, in the finding's thread", async () => {
		const { github, context } = setup();
		postFinding(github);
		github.reviewComments.push(reply(11, 'Is this not intended?'));
		const model = answer('It is not: the old value was 5.');

		await runChatJob(
			job(
				{ id: 11, kind: 'review', rootCommentId: 10, author: 'octocat', authorAssociation: 'NONE' },
				{ unmentioned: true }
			),
			context,
			{ model }
		);

		const posted = github.reviewComments.at(-1)!;
		expect(posted).toMatchObject({ bot: true, inReplyToId: 10 });
		expect(posted.body).toBe('It is not: the old value was 5.\n\n<!-- hansi:chat 11 -->');
		const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
		expect(prompt).toContain('v5 overflows');
		expect(prompt).toContain('<thread path=\\"app.ts\\" line=\\"5\\">');
	});

	test("ignores a reply without a mention in a person's thread", async () => {
		const { github, context } = setup();
		github.reviewComments.push(
			{ ...reply(10, 'Nice.'), inReplyToId: undefined },
			reply(11, 'Thanks!')
		);

		await runChatJob(
			job({ id: 11, kind: 'review', rootCommentId: 10 }, { unmentioned: true }),
			context,
			{ model: scriptedModel([]) }
		);

		expect(github.reviewComments).toHaveLength(2);
	});

	test('ignores people without write access other than the author, and bots', async () => {
		const { github, context } = setup();
		github.issueComments.push(
			{ id: 1, body: '@hansi hi', author: 'drive-by', bot: false, url: 'memory://1' },
			{ id: 2, body: '@hansi hi', author: 'other[bot]', bot: true, url: 'memory://2' }
		);

		await runChatJob(job({ id: 1, author: 'drive-by', authorAssociation: 'NONE' }), context, {
			model: scriptedModel([])
		});
		await runChatJob(job({ id: 2, author: 'other[bot]' }), context, {
			model: scriptedModel([])
		});

		expect(github.issueComments).toHaveLength(2);
		expect(github.reactions).toHaveLength(0);
	});

	test('answers the author of the pull request without write access', async () => {
		const { github, context } = setup();
		github.issueComments.push({
			id: 1,
			body: '@hansi is this fine?',
			author: 'octocat',
			bot: false,
			url: 'memory://1'
		});

		await runChatJob(job({ author: 'octocat', authorAssociation: 'CONTRIBUTOR' }), context, {
			model: answer('Yes.')
		});

		expect(github.issueComments.at(-1)!.body).toStartWith('@octocat Yes.');
	});

	test('ignores a comment deleted since it was queued', async () => {
		const { github, context } = setup();

		await runChatJob(job(), context, { model: scriptedModel([]) });

		expect(github.issueComments).toHaveLength(0);
	});
});
