import { describe, expect, test } from 'bun:test';
import type { ModelUsage } from '@hansi/engine';
import type { EvalCase } from './case';
import { renderMarkdown, summarize, type Report } from './report';
import type { CaseRun } from './run';
import type { CaseScore } from './score';

const evalCase = (id: string, findings: string[]): EvalCase => ({
	id,
	description: id,
	repo: 'appwrite/hansi',
	base: 'a'.repeat(40),
	head: 'b'.repeat(40),
	pullRequest: { title: id, body: '', author: 'octocat' },
	linkedIssues: [],
	expected: {
		verdict: findings.length ? 'request_changes' : 'approve',
		findings: findings.map((f) => ({ id: f, path: 'x.ts', lines: [1, 1], issue: f }))
	}
});

const usage: ModelUsage = {
	role: 'review',
	provider: 'anthropic',
	model: 'claude',
	inputTokens: 1000,
	outputTokens: 100,
	cachedInputTokens: 0,
	reasoningTokens: 0,
	durationMs: 10
};

const completed = (
	id: string,
	run: number,
	score: Partial<CaseScore>,
	durationMs = 10_000
): CaseRun => ({
	case: id,
	run,
	status: 'completed',
	tier: 'B',
	durationMs,
	usage: [usage],
	commands: 2,
	score: {
		expected: 0,
		caught: [],
		missed: [],
		droppedHits: [],
		posted: 0,
		extra: [],
		verdict: 'approve',
		verdictOk: null,
		...score
	}
});

const cases = [evalCase('bug', ['x', 'y']), evalCase('clean', [])];
const runs: CaseRun[] = [
	completed('bug', 1, {
		expected: 2,
		caught: ['x'],
		missed: ['y'],
		droppedHits: [{ expected: 'y', reason: 'Verifier: no' }],
		posted: 3,
		extra: [{ path: 'x.ts', startLine: 9, severity: 'minor', title: 'Other' }],
		verdict: 'request_changes',
		verdictOk: true
	}),
	completed('bug', 2, { expected: 2, caught: ['x', 'y'], posted: 2, verdictOk: true }),
	completed('clean', 1, { posted: 1, verdictOk: false }),
	{ case: 'clean', run: 2, status: 'failed', error: 'rate limited', durationMs: 5 }
];
const price = (u: ModelUsage) => u.inputTokens / 1_000_000;

describe('summarize', () => {
	test('aggregates recall, precision, false alarms and cost over completed reviews', () => {
		const { summary, cases: perCase } = summarize(cases, runs, price);
		expect(summary).toMatchObject({
			reviews: 4,
			completed: 3,
			failed: 1,
			recall: 3 / 4,
			precision: 3 / 5,
			falseAlarmRate: 1,
			droppedHits: 1,
			verdictAccuracy: 2 / 3,
			costUsd: 0.003,
			costPerReviewUsd: 0.001,
			meanDurationMs: 10_000,
			meanCommands: 2
		});
		expect(perCase[0]).toMatchObject({ case: 'bug', runs: 2, caught: { x: 2, y: 1 } });
		expect(perCase[1]).toMatchObject({ case: 'clean', failures: ['rate limited'] });
	});

	test('leaves cost out when no model has a price', () => {
		const { summary } = summarize(cases, runs, () => null);
		expect(summary.costUsd).toBeNull();
		expect(summary.costPerReviewUsd).toBeNull();
	});
});

describe('renderMarkdown', () => {
	test('prints the headline numbers, each case, failures and an earlier run', () => {
		const { summary, cases: perCase } = summarize(cases, runs, price);
		const report: Report = {
			startedAt: '2026-11-18T00:00:00.000Z',
			label: 'normal · anthropic:claude',
			settings: {},
			summary,
			cases: perCase,
			runs
		};
		const previous = { ...report, label: 'before', summary: { ...summary, recall: 0.5 } };
		const markdown = renderMarkdown(report, previous);
		expect(markdown).toContain('3 of 4 reviews completed, 1 failed');
		expect(markdown).toContain('| Recall | 75% | 50% |');
		expect(markdown).toContain('| bug | x 2/2, y 1/2 | 0.5 | 2/2 |');
		expect(markdown).toContain('| clean ⚠️ 1 failed | clean |');
		expect(markdown).toContain('- clean: rate limited');
	});
});
