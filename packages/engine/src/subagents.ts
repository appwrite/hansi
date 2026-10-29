import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { runToSubmission } from './agent-loop';
import { renderFileDiff, type FileDiff } from './diff';
import { findingSchema, type Finding } from './findings';
import { cachedPrompt, callModel, type ModelCallHooks } from './model-call';
import type { ReviewModel } from './review';
import type { EmitEvent } from './tools';

/** Subagents the reviewer may start in one review. */
export const MAX_SUBAGENTS = 6;
/** Subagents running at once: each one is a stream of requests on the user's model key. */
export const MAX_CONCURRENT_SUBAGENTS = 3;
export const MAX_SUBAGENT_STEPS = 30;
/** Diff shown to one subagent; it reads the rest with tools. */
const MAX_SUBAGENT_DIFF_CHARS = 60_000;

/** Added to the instructions of every agent when subagents share the sandbox. */
export const SHARED_SANDBOX_GUIDANCE =
	'Other reviewers may run commands in the same sandbox at the same time. Do not modify, move, or delete files in the working directory; write scratch files only under a new directory in /tmp.';

const reportSchema = z.object({
	findings: z.array(findingSchema),
	notes: z
		.string()
		.describe('For the lead reviewer: what you checked, ruled out, or could not settle')
});

export interface DelegateOptions {
	model: ReviewModel;
	instructions: string;
	/** Prompt sections every subagent sees: the pull request and the team's rules. */
	context: string[];
	/** Every reviewable changed file, including the ones not shown to the lead reviewer. */
	files: FileDiff[];
	/** Changed files that are not reviewed line by line, such as deleted or path-filtered ones. */
	excluded: { path: string; reason: string }[];
	/** Tools for one subagent, reporting through its own `emit`. */
	tools: (emit: EmitEvent) => ToolSet;
	emit: EmitEvent;
	hooks: ModelCallHooks;
	/** Receives every subagent's findings, which join the reviewer's own. */
	onFindings: (findings: Finding[]) => void;
	maxSubagents?: number;
	maxSteps?: number;
	maxConcurrent?: number;
}

/**
 * The `delegate` tool: the reviewer hands one task to a subagent, which runs its own agent loop
 * with the same tools and reports findings and notes. The SDK runs tool calls from one step in
 * parallel, so several delegate calls in a step are subagents working at the same time.
 */
export function createDelegateTool(options: DelegateOptions) {
	const maxSubagents = options.maxSubagents ?? MAX_SUBAGENTS;
	const slots = semaphore(options.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS);
	let started = 0;
	return tool({
		description: `Start a subagent: another reviewer with the same tools that works on one task in parallel and reports its findings and notes. Several calls in one step run at the same time. At most ${maxSubagents} per review.`,
		inputSchema: z.object({
			task: z
				.string()
				.min(1)
				.describe(
					'What to review or check, self-contained: the subagent does not see your conversation'
				),
			paths: z
				.array(z.string())
				.describe('Changed files the task is about; the subagent sees their full diff')
		}),
		execute: async ({ task, paths }, { abortSignal }) => {
			if (started >= maxSubagents) {
				options.emit({ type: 'subagent.skipped', data: { task, reason: 'limit' } });
				return `Not started: the limit of ${maxSubagents} subagents for this review is used up. Do this part yourself.`;
			}
			const agent = `sub-${++started}`;
			const emit: EmitEvent = (event) => options.emit({ ...event, data: { ...event.data, agent } });
			const release = await slots.acquire();
			const startedAt = Date.now();
			emit({ type: 'subagent.started', data: { task, paths } });
			try {
				const submit = tool({
					description:
						'Report your findings and notes to the lead reviewer. Call exactly once, at the end.',
					inputSchema: reportSchema,
					execute: async () => 'Reported.'
				});
				const result = await callModel('review', options.model, options.hooks, () =>
					runToSubmission('report', options.maxSteps ?? MAX_SUBAGENT_STEPS, options.model, {
						instructions: options.instructions,
						prompt: cachedPrompt(options.model, subagentPrompt(options, task, paths)),
						tools: { ...options.tools(emit), report: submit },
						abortSignal
					})
				);
				const call = result.toolCalls.findLast((c) => c.toolName === 'report' && !c.invalid);
				if (!call) {
					emit({ type: 'subagent.completed', data: { findings: 0, ms: Date.now() - startedAt } });
					return 'The subagent finished without a report. Do this part yourself.';
				}
				const report = reportSchema.parse(call.input);
				options.onFindings(report.findings);
				emit({
					type: 'subagent.completed',
					data: { findings: report.findings.length, ms: Date.now() - startedAt }
				});
				const titles = report.findings.map((f) => `- ${f.path}:${f.startLine} ${f.title}`);
				return [
					`Subagent ${agent} reported ${report.findings.length} finding(s), already added to the review:`,
					...titles,
					'',
					`Notes: ${report.notes}`
				].join('\n');
			} catch (error) {
				// A cancelled review stops here; any other failure only loses this subagent's part.
				if (abortSignal?.aborted || options.hooks.signal?.aborted) throw error;
				const message = (error as Error).message;
				emit({ type: 'subagent.failed', data: { error: message, ms: Date.now() - startedAt } });
				return `The subagent failed (${message}). Do this part yourself.`;
			} finally {
				release();
			}
		}
	});
}

function subagentPrompt(options: DelegateOptions, task: string, paths: string[]): string {
	const wanted = new Set(paths);
	let budget = MAX_SUBAGENT_DIFF_CHARS;
	const shown: string[] = [];
	const notShown: string[] = [];
	for (const file of options.files.filter((f) => wanted.has(f.path))) {
		const rendered = renderFileDiff(file);
		if (rendered.length > budget) {
			notShown.push(file.path);
			continue;
		}
		budget -= rendered.length;
		shown.push(rendered);
	}
	const changed = options.files.map((f) => `- ${f.path}`).join('\n');
	const excluded = options.excluded.filter((f) => wanted.has(f.path));
	const unknown = paths.filter(
		(path) => ![...options.files, ...options.excluded].some((f) => f.path === path)
	);
	const parts = [
		...options.context,
		`<task>\n${task}\n</task>`,
		`<changed_files>\nThe files this pull request changes that are reviewed. Findings can only go on changed lines of these files.\n${changed}\n</changed_files>`
	];
	if (notShown.length || excluded.length || unknown.length) {
		const lines = [
			...notShown.map((path) => `- ${path} (too large to show: read it with the tools)`),
			...excluded.map((f) => `- ${f.path} (changed, but not reviewed line by line: ${f.reason})`),
			...unknown.map((path) => `- ${path} (not changed in this pull request)`)
		];
		const deleted = excluded.some((f) => f.reason === 'deleted')
			? '\nDeleted files may still be imported or called elsewhere: use grep to check whether the changed files still use them.'
			: '';
		parts.push(`<files_not_shown>\n${lines.join('\n')}${deleted}\n</files_not_shown>`);
	}
	parts.push(
		`<diff>\nThe files your task is about. Each line: new-file line number, marker (+ added, - removed, space context), content.\n\n${shown.join('\n\n')}\n</diff>`
	);
	return parts.join('\n\n');
}

/** Lets at most `limit` callers hold a slot at once; the rest wait in order. */
export function semaphore(limit: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	const release = () => {
		active--;
		waiting.shift()?.();
	};
	return {
		acquire: async (): Promise<() => void> => {
			if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
			active++;
			return release;
		}
	};
}
