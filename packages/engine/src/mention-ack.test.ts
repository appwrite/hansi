import { expect, test } from 'bun:test';
import {
	acknowledgeReviewMention,
	closedPullRequestSkip,
	configuredReviewSkip,
	mentionSkipReasons,
	mentionSkipReply,
	mentionWantsSkipReply,
	postMentionReply,
	reviewMentionComment,
	type ConfiguredSkipInput
} from './mention-ack';

const triggers = ['mention', 'opened', 'synchronize', 'manual'] as const;

function config(overrides: Partial<ConfiguredSkipInput> = {}): ConfiguredSkipInput {
	return {
		trigger: 'mention',
		enabled: true,
		auto: true,
		draft: false,
		reviewDrafts: false,
		baseBranches: [],
		baseRef: 'main',
		...overrides
	};
}

test('only a mention gets a reply when a review is skipped', () => {
	expect(mentionWantsSkipReply('mention')).toBe(true);
	for (const trigger of ['opened', 'synchronize', 'manual']) {
		expect(mentionWantsSkipReply(trigger)).toBe(false);
	}
});

test('a mention is told why the review was skipped', () => {
	expect(mentionSkipReply('mention', 'merged')).toBe(
		"This pull request is merged, so Hansi doesn't review it anymore."
	);
	expect(mentionSkipReply('mention', 'closed')).toBe(
		"This pull request is closed, so Hansi doesn't review it anymore."
	);
	expect(mentionSkipReply('mention', 'disabled')).toBe(
		"Reviews are disabled for this repository, so Hansi doesn't review it."
	);
	expect(mentionSkipReply('mention', 'draft')).toBe(
		"This pull request is a draft, so Hansi doesn't review it yet."
	);
	expect(mentionSkipReply('mention', 'base-branch', { baseRef: 'develop' })).toBe(
		"This pull request targets develop, which Hansi doesn't review."
	);
});

test('pushes and other non-mention triggers stay quiet for every skip reason', () => {
	for (const reason of mentionSkipReasons) {
		for (const trigger of triggers) {
			if (trigger === 'mention') continue;
			expect(mentionSkipReply(trigger, reason, { baseRef: 'main' })).toBeNull();
		}
	}
});

test('skip replies do not mention the bot', () => {
	const replies = mentionSkipReasons.map((reason) =>
		mentionSkipReply('mention', reason, { baseRef: 'release' })
	);
	for (const reply of replies) {
		expect(reply).toBeString();
		expect(reply).not.toContain('@');
	}
	expect(mentionSkipReply('mention', 'base-branch', { baseRef: 'feat/@hansi-codes' })).toBe(
		"This pull request's base branch isn't one Hansi reviews."
	);
	expect(mentionSkipReply('mention', 'base-branch')).toBe(
		"This pull request's base branch isn't one Hansi reviews."
	);
});

test('a merged pull request is told apart from one that was closed', () => {
	expect(closedPullRequestSkip({ state: 'open', merged: false })).toBeNull();
	expect(closedPullRequestSkip({ state: 'closed', merged: true })).toBe('merged');
	expect(closedPullRequestSkip({ state: 'closed', merged: false })).toBe('closed');
});

test('disabling reviews skips a mention; drafts and base branches do not', () => {
	expect(configuredReviewSkip(config({ enabled: false }))).toBe('disabled');
	expect(configuredReviewSkip(config({ auto: false }))).toBeNull();
	expect(configuredReviewSkip(config({ draft: true }))).toBeNull();
	expect(configuredReviewSkip(config({ baseBranches: ['main'], baseRef: 'develop' }))).toBeNull();
});

test('opened and synchronize still skip drafts, other base branches, and automatic off', () => {
	expect(configuredReviewSkip(config({ trigger: 'opened', auto: false }))).toBe(
		'automatic-disabled'
	);
	expect(configuredReviewSkip(config({ trigger: 'synchronize', draft: true }))).toBe('draft');
	expect(
		configuredReviewSkip(config({ trigger: 'opened', baseBranches: ['main'], baseRef: 'develop' }))
	).toBe('base-branch');
	expect(configuredReviewSkip(config({ trigger: 'manual', draft: true, auto: false }))).toBeNull();
	expect(configuredReviewSkip(config({ trigger: 'opened', draft: true, reviewDrafts: true }))).toBe(
		null
	);
	expect(
		configuredReviewSkip(config({ trigger: 'opened', baseBranches: [], baseRef: 'develop' }))
	).toBeNull();
});

test('the comment id and kind come from the mention trigger', () => {
	expect(
		reviewMentionComment({
			trigger: { kind: 'mention', comment: { id: 6032071535, kind: 'issue' } }
		})
	).toEqual({ id: 6032071535, kind: 'issue' });
	expect(
		reviewMentionComment({ trigger: { kind: 'mention', comment: { id: 9, kind: 'review' } } })
	).toEqual({ id: 9, kind: 'review' });
	expect(reviewMentionComment({ trigger: { kind: 'synchronize' } })).toBeNull();
});

test('a reaction failure is logged and does not throw', async () => {
	const warnings: unknown[] = [];
	const log = {
		info() {},
		warn(message: string, fields?: Record<string, unknown>) {
			warnings.push({ ...fields, message });
		}
	};
	await acknowledgeReviewMention(() => Promise.reject(new Error('GitHub 403')), log);
	expect(warnings).toEqual([{ err: expect.any(Error), message: 'could not react to comment' }]);
});

test('a reply failure is logged and does not throw', async () => {
	const warnings: string[] = [];
	await postMentionReply(
		() => Promise.reject(new Error('GitHub 502')),
		"This pull request is merged, so Hansi doesn't review it anymore.",
		{
			info() {},
			warn(message) {
				warnings.push(message);
			}
		},
		'could not reply that this review was skipped'
	);
	expect(warnings).toEqual(['could not reply that this review was skipped']);
});

test('a successful reaction does not warn', async () => {
	let seen = 0;
	await acknowledgeReviewMention(
		async () => {
			seen = 42;
		},
		{
			info() {},
			warn() {
				throw new Error('should not warn');
			}
		}
	);
	expect(seen).toBe(42);
});
