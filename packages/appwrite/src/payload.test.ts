import { describe, expect, test } from 'bun:test';
import { InvalidJobError, parseJob } from './payload';

const repository = {
	projectId: 'project1',
	projectInternalId: 12,
	repositoryId: 'repo1',
	installationId: 'installation1',
	providerInstallationId: 4567,
	providerRepositoryId: '890',
	owner: 'appwrite',
	name: 'appwrite'
};

const review = {
	type: 'review',
	reviewId: 'review1',
	repository,
	pullNumber: 42,
	headSha: 'a'.repeat(40),
	trigger: { kind: 'synchronize' }
};

describe('parseJob', () => {
	test('parses a review job and normalizes provider ids to strings', () => {
		const job = parseJob(review);

		expect(job.type).toBe('review');
		expect(job.repository.projectInternalId).toBe('12');
		expect(job.repository.providerInstallationId).toBe('4567');
	});

	test('parses a mention review with its comment', () => {
		const job = parseJob({
			...review,
			trigger: { kind: 'mention', comment: { id: 7, kind: 'issue' } }
		});

		expect(job).toMatchObject({ trigger: { kind: 'mention', comment: { id: 7, kind: 'issue' } } });
	});

	test('parses a mention review without a head, and ready for review as opened', () => {
		const mention = parseJob({
			...review,
			headSha: '',
			trigger: { kind: 'mention', comment: { id: 7, kind: 'review' } }
		});
		const ready = parseJob({ ...review, trigger: { kind: 'ready_for_review' } });

		expect(mention).toMatchObject({ headSha: '' });
		expect(ready).toMatchObject({ trigger: { kind: 'opened' } });
	});

	test('parses a chat job', () => {
		const job = parseJob({
			type: 'chat',
			repository,
			pullNumber: 42,
			comment: {
				id: 9,
				kind: 'review',
				rootCommentId: 8,
				author: 'octocat',
				authorAssociation: 'MEMBER',
				url: 'https://github.com/appwrite/appwrite/pull/42#discussion_r9'
			}
		});

		expect(job.type).toBe('chat');
	});

	test('rejects an unknown job type', () => {
		expect(() => parseJob({ ...review, type: 'deploy' })).toThrow(InvalidJobError);
	});

	test('rejects a short head sha', () => {
		expect(() => parseJob({ ...review, headSha: 'abc123' })).toThrow(InvalidJobError);
	});

	test('rejects a mention without its comment', () => {
		expect(() => parseJob({ ...review, trigger: { kind: 'mention' } })).toThrow(InvalidJobError);
	});
});
