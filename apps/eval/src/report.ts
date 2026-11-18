import type { ModelUsage } from '@hansi/engine';
import type { EvalCase } from './case';
import type { CaseRun } from './run';

/** Cost in USD of one model's usage, or null when the model has no known price. */
export type Pricer = (usage: ModelUsage) => number | null;

export interface Summary {
	reviews: number;
	completed: number;
	skipped: number;
	failed: number;
	/** Expected problems a posted finding caught, out of all expected, over completed reviews. */
	recall: number | null;
	/**
	 * Posted findings that caught an expected problem, out of all posted on cases with expected
	 * problems. Labels may be incomplete, so an extra finding is not always wrong.
	 */
	precision: number | null;
	/** Reviews of clean cases that posted any finding, out of all reviews of clean cases. */
	falseAlarmRate: number | null;
	/** Expected problems a finding caught, then the verifier or a filter dropped. */
	droppedHits: number;
	verdictAccuracy: number | null;
	/** Null when no model in the run has a known price. */
	costUsd: number | null;
	costPerReviewUsd: number | null;
	meanDurationMs: number | null;
	meanCommands: number | null;
}

export interface CaseSummary {
	case: string;
	runs: number;
	expected: number;
	/** Per expected problem, how many runs caught it. */
	caught: Record<string, number>;
	meanExtra: number | null;
	verdictOk: number;
	verdictScored: number;
	failures: string[];
	costPerReviewUsd: number | null;
	meanDurationMs: number | null;
}

export interface Report {
	startedAt: string;
	label: string;
	settings: Record<string, unknown>;
	summary: Summary;
	cases: CaseSummary[];
	runs: (CaseRun & { costUsd?: number | null })[];
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const mean = (values: number[]) =>
	values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** A review's cost, or null when none of its models has a price. */
export function runCost(usage: ModelUsage[], price: Pricer): number | null {
	const costs = usage.map(price).filter((c): c is number => c !== null);
	return costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
}

export function summarize(
	cases: EvalCase[],
	runs: CaseRun[],
	price: Pricer
): { summary: Summary; cases: CaseSummary[] } {
	const byId = new Map(cases.map((c) => [c.id, c]));
	const completed = runs.filter((r) => r.status === 'completed');
	const isClean = (id: string) => byId.get(id)?.expected.findings.length === 0;
	const onBugCases = completed.filter((r) => !isClean(r.case));
	const onCleanCases = completed.filter((r) => isClean(r.case));
	const scored = completed.filter((r) => r.score.verdictOk !== null);
	const costs = completed.map((r) => runCost(r.usage, price));
	const priced = costs.filter((c): c is number => c !== null);

	const summary: Summary = {
		reviews: runs.length,
		completed: completed.length,
		skipped: runs.filter((r) => r.status === 'skipped').length,
		failed: runs.filter((r) => r.status === 'failed').length,
		recall: ratio(
			sum(onBugCases.map((r) => r.score.caught.length)),
			sum(onBugCases.map((r) => r.score.expected))
		),
		precision: ratio(
			sum(onBugCases.map((r) => r.score.caught.length)),
			sum(onBugCases.map((r) => r.score.posted))
		),
		falseAlarmRate: ratio(
			onCleanCases.filter((r) => r.score.posted > 0).length,
			onCleanCases.length
		),
		droppedHits: sum(completed.map((r) => r.score.droppedHits.length)),
		verdictAccuracy: ratio(scored.filter((r) => r.score.verdictOk).length, scored.length),
		costUsd: priced.length === 0 ? null : sum(priced),
		costPerReviewUsd: mean(priced),
		meanDurationMs: mean(completed.map((r) => r.durationMs)),
		meanCommands: mean(completed.map((r) => r.commands))
	};

	const perCase = cases.map((evalCase): CaseSummary => {
		const own = runs.filter((r) => r.case === evalCase.id);
		const done = own.filter((r) => r.status === 'completed');
		const caught = Object.fromEntries(
			evalCase.expected.findings.map((f) => [
				f.id,
				done.filter((r) => r.score.caught.includes(f.id)).length
			])
		);
		const ownCosts = done
			.map((r) => runCost(r.usage, price))
			.filter((c): c is number => c !== null);
		return {
			case: evalCase.id,
			runs: own.length,
			expected: evalCase.expected.findings.length,
			caught,
			meanExtra: mean(done.map((r) => r.score.extra.length)),
			verdictOk: done.filter((r) => r.score.verdictOk === true).length,
			verdictScored: done.filter((r) => r.score.verdictOk !== null).length,
			failures: own.flatMap((r) =>
				r.status === 'failed' ? [r.error] : r.status === 'skipped' ? [`skipped: ${r.reason}`] : []
			),
			costPerReviewUsd: mean(ownCosts),
			meanDurationMs: mean(done.map((r) => r.durationMs))
		};
	});

	return { summary, cases: perCase };
}

function sum(values: number[]): number {
	return values.reduce((a, b) => a + b, 0);
}

const percent = (value: number | null) => (value === null ? '–' : `${(value * 100).toFixed(0)}%`);
const usd = (value: number | null) => (value === null ? '–' : `$${value.toFixed(3)}`);
const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(0)}s`);
const number = (value: number | null) => (value === null ? '–' : value.toFixed(1));

/** The headline numbers, in the order a report prints them. */
const HEADLINES: { key: keyof Summary; label: string; format: (v: number | null) => string }[] = [
	{ key: 'recall', label: 'Recall', format: percent },
	{ key: 'precision', label: 'Precision (vs labels)', format: percent },
	{ key: 'falseAlarmRate', label: 'False alarms on clean PRs', format: percent },
	{ key: 'verdictAccuracy', label: 'Verdict accuracy', format: percent },
	{ key: 'droppedHits', label: 'Real problems dropped', format: (v) => String(v ?? 0) },
	{ key: 'costPerReviewUsd', label: 'Cost per review', format: usd },
	{ key: 'meanDurationMs', label: 'Time per review', format: seconds },
	{ key: 'meanCommands', label: 'Commands per review', format: number }
];

/** The report as Markdown, with a column of differences when `previous` is given. */
export function renderMarkdown(report: Report, previous?: Report): string {
	const { summary } = report;
	const lines = [
		`# Hansi eval: ${report.label}`,
		'',
		`${summary.completed} of ${summary.reviews} reviews completed` +
			(summary.failed ? `, ${summary.failed} failed` : '') +
			(summary.skipped ? `, ${summary.skipped} skipped` : '') +
			`. Total cost ${usd(summary.costUsd)}.`,
		''
	];

	const header = previous
		? ['| Metric | This run | ' + previous.label + ' |', '| --- | --- | --- |']
		: ['| Metric | Value |', '| --- | --- |'];
	lines.push(...header);
	for (const { key, label, format } of HEADLINES) {
		const value = summary[key];
		const before = previous?.summary[key];
		lines.push(
			previous
				? `| ${label} | ${format(value)} | ${format(before ?? null)} |`
				: `| ${label} | ${format(value)} |`
		);
	}

	lines.push(
		'',
		'| Case | Caught | Extra findings | Verdict | Cost | Time |',
		'| --- | --- | --- | --- | --- | --- |'
	);
	for (const c of report.cases) {
		const caught =
			c.expected === 0
				? 'clean'
				: Object.entries(c.caught)
						.map(([id, n]) => `${id} ${n}/${c.runs}`)
						.join(', ');
		const verdict = c.verdictScored === 0 ? '–' : `${c.verdictOk}/${c.verdictScored}`;
		const failures = c.failures.length ? ` ⚠️ ${c.failures.length} failed` : '';
		lines.push(
			`| ${c.case}${failures} | ${caught} | ${number(c.meanExtra)} | ${verdict} | ${usd(c.costPerReviewUsd)} | ${seconds(c.meanDurationMs)} |`
		);
	}

	const failures = report.cases.flatMap((c) => c.failures.map((f) => `- ${c.case}: ${f}`));
	if (failures.length) lines.push('', '## Failures', '', ...failures);
	return lines.join('\n') + '\n';
}
