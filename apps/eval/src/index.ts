import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { modelUsage, type Log, type ModelUsage, type Strength } from '@hansi/engine';
import { OrchestratorSandboxClient } from '@hansi/sandbox';
import { createReviewModel, createStrengths } from '@hansi/service/models';
import { estimateCost, findPrice, loadPriceCatalog } from '@hansi/service/pricing';
import { loadCases, type EvalCase } from './case';
import { loadEvalEnv } from './env';
import { modelJudge } from './judge';
import { renderMarkdown, runCost, summarize, type Report } from './report';
import { checkoutCase, reviewCase, type CaseRun, type RunSettings } from './run';
import { DEFAULT_TOLERANCE } from './score';

const HELP = `Replays eval cases through a real review and scores what it finds.

Usage: bun run eval [options]

  --strength <s>     basic, normal or expert (default normal)
  --case <id>        Only cases whose id contains this; repeatable
  --runs <n>         Reviews per case, since models are not deterministic (default 1)
  --concurrency <n>  Reviews at once (default 2)
  --judge            Let a model decide which finding reports an expected problem, instead
                     of matching by file and line
  --tolerance <n>    Lines a finding may sit from an expected problem (default ${DEFAULT_TOLERANCE})
  --label <text>     Name of this run in the report (default: the strength and review model)
  --out <file>       Where to write the JSON report (default results/<time>-<strength>.json)
  --compare <file>   An earlier JSON report to print next to this one
  --help

Models come from the service's variables: HANSI_REVIEW_MODEL, HANSI_AI_SECRET and the rest
(see the README). HANSI_JUDGE_MODEL sets the judge's model, the verify model by default. With
HANSI_ORCHESTRATOR_ENDPOINT and HANSI_SANDBOX_IMAGE, normal and expert reviews run commands.
GITHUB_TOKEN is used to clone private repositories.`;

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({
	options: {
		strength: { type: 'string', default: 'normal' },
		case: { type: 'string', multiple: true, default: [] },
		runs: { type: 'string', default: '1' },
		concurrency: { type: 'string', default: '2' },
		judge: { type: 'boolean', default: false },
		tolerance: { type: 'string', default: String(DEFAULT_TOLERANCE) },
		label: { type: 'string' },
		out: { type: 'string' },
		compare: { type: 'string' },
		help: { type: 'boolean', default: false }
	}
});

if (values.help) {
	console.log(HELP);
	process.exit(0);
}

const strength = values.strength as Strength;
if (!['basic', 'normal', 'expert'].includes(strength)) fail(`unknown strength ${strength}`);
const runs = positive(values.runs, 'runs');
const concurrency = positive(values.concurrency, 'concurrency');
const tolerance = Number(values.tolerance);
if (!Number.isInteger(tolerance) || tolerance < 0) fail('--tolerance must be 0 or more');

const env = loadEvalEnv(process.env, fail);
const strengths = createStrengths(env)[strength];
const log: Log = {
	info: () => {},
	warn: (message, fields) => console.warn(`warn: ${message}`, fields ?? '')
};

const judgeModelId = env.HANSI_JUDGE_MODEL ?? env.HANSI_VERIFY_MODEL ?? env.HANSI_REVIEW_MODEL;
const judgeUsage: ModelUsage[] = [];
const settings: RunSettings = {
	models: strengths.models,
	subagents: strengths.subagents,
	sandboxes:
		strengths.sandboxes && env.HANSI_ORCHESTRATOR_ENDPOINT && env.HANSI_SANDBOX_IMAGE
			? new OrchestratorSandboxClient({
					endpoint: env.HANSI_ORCHESTRATOR_ENDPOINT,
					apiKey: env.HANSI_ORCHESTRATOR_KEY,
					image: env.HANSI_SANDBOX_IMAGE,
					runtimeClass: env.HANSI_SANDBOX_RUNTIME_CLASS
				})
			: undefined,
	judge: values.judge
		? modelJudge(
				createReviewModel(env, judgeModelId, env.HANSI_VERIFY_REASONING),
				(call) => void judgeUsage.push(modelUsage(call))
			)
		: undefined,
	tolerance,
	token: process.env.GITHUB_TOKEN || undefined,
	log
};

const cases = await loadCases(join(root, 'cases'), values.case);
if (cases.length === 0) fail('no cases match');

const reviewModel = strengths.models.review;
const label = values.label ?? `${strength} · ${reviewModel.provider}:${reviewModel.modelId}`;
console.error(
	`Reviewing ${cases.length} case(s) ${runs} time(s) at ${strength}` +
		(settings.sandboxes ? ' with a sandbox' : ', without a sandbox') +
		(settings.judge ? `, judged by ${judgeModelId}` : '') +
		'.'
);

const startedAt = new Date();
const results = await runAll(cases);
const catalog = await loadPriceCatalog();
const pricer = (usage: ModelUsage) =>
	estimateCost(findPrice(catalog, usage.provider, usage.model), {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		inputTokenDetails: { cacheReadTokens: usage.cachedInputTokens }
	});
const { summary, cases: perCase } = summarize(cases, results, pricer);

const report: Report = {
	startedAt: startedAt.toISOString(),
	label,
	settings: {
		strength,
		review: `${reviewModel.provider}:${reviewModel.modelId}`,
		verify: strengths.models.verify
			? `${strengths.models.verify.provider}:${strengths.models.verify.modelId}`
			: null,
		reasoning: env.HANSI_REVIEW_REASONING ?? null,
		subagents: strengths.subagents,
		sandbox: !!settings.sandboxes,
		judge: settings.judge ? judgeModelId : null,
		judgeCostUsd: settings.judge ? runCost(judgeUsage, pricer) : null,
		tolerance,
		runs
	},
	summary,
	cases: perCase,
	runs: results
};

const out =
	values.out ??
	join(root, 'results', `${startedAt.toISOString().replace(/[:.]/g, '-')}-${strength}.json`);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, '\t') + '\n');
const previous = values.compare
	? (JSON.parse(await readFile(values.compare, 'utf8')) as Report)
	: undefined;
console.log(renderMarkdown(report, previous));
console.error(`Report written to ${out}`);

/** Checks out each case once and reviews it `runs` times, `concurrency` reviews at once. */
async function runAll(all: EvalCase[]): Promise<CaseRun[]> {
	const results: CaseRun[] = [];
	const tasks = all.flatMap((evalCase) =>
		Array.from({ length: runs }, (_, i) => ({ evalCase, run: i + 1 }))
	);
	const checkouts = new Map<string, ReturnType<typeof checkoutCase>>();
	const left = new Map(all.map((c) => [c.id, runs]));

	const worker = async () => {
		for (let task = tasks.shift(); task; task = tasks.shift()) {
			const { evalCase, run } = task;
			let checkout = checkouts.get(evalCase.id);
			if (!checkout) {
				checkout = checkoutCase(evalCase, { token: settings.token });
				checkouts.set(evalCase.id, checkout);
			}
			const result = await checkout.then(
				(c) => reviewCase(evalCase, c, settings, run),
				(error: unknown): CaseRun => ({
					case: evalCase.id,
					run,
					status: 'failed',
					error: `checkout failed: ${(error as Error).message}`,
					durationMs: 0
				})
			);
			results.push(result);
			console.error(progressLine(result));
			const remaining = left.get(evalCase.id)! - 1;
			left.set(evalCase.id, remaining);
			if (remaining === 0) await checkout.then((c) => c.close()).catch(() => {});
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results.sort((a, b) => a.case.localeCompare(b.case) || a.run - b.run);
}

function progressLine(result: CaseRun): string {
	const name = `${result.case} #${result.run}`;
	if (result.status === 'failed') return `✗ ${name}: ${result.error}`;
	if (result.status === 'skipped') return `- ${name}: skipped, ${result.reason}`;
	const { score } = result;
	return `✓ ${name}: caught ${score.caught.length}/${score.expected}, ${score.extra.length} extra, ${score.verdict}, ${(result.durationMs / 1000).toFixed(0)}s`;
}

function positive(value: string, name: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive whole number`);
	return n;
}

function fail(message: string): never {
	console.error(`error: ${message}\n\nRun with --help for usage.`);
	process.exit(1);
}
