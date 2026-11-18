import { reasoningCallOptions, type ModelCall, type ReviewModel } from '@hansi/engine';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import type { Judge, ReportedFinding } from './score';
import type { ExpectedFinding } from './case';

const INSTRUCTIONS = `You grade an AI code reviewer. You get one known problem in a pull request and the findings the reviewer posted on the same file. Decide which finding, if any, reports that problem.

A finding reports the problem when a developer reading it would find and fix that problem: same root cause, even if it is worded differently, placed on a nearby or calling line, or rated at a different severity. A finding about a different problem on the same lines does not count, and neither does a vague remark that only gestures at the area.

Call submit_match with the finding's number, or null when none reports the problem.`;

/** A judge that asks `model` which finding reports an expected problem. */
export function modelJudge(model: ReviewModel, onModelCall?: (call: ModelCall) => void): Judge {
	return async (expected, candidates) => {
		const started = performance.now();
		const result = await generateText({
			model: model.model,
			...reasoningCallOptions(model),
			system: INSTRUCTIONS,
			prompt: judgePrompt(expected, candidates),
			tools: {
				submit_match: tool({
					description: 'Submit which finding reports the known problem',
					inputSchema: z.object({
						finding: z
							.number()
							.int()
							.nullable()
							.describe('Number of the finding that reports the problem, or null'),
						reason: z.string().describe('One sentence')
					})
				})
			},
			toolChoice: { type: 'tool', toolName: 'submit_match' }
		});
		onModelCall?.({
			role: 'verify',
			provider: model.provider,
			modelId: model.modelId,
			reasoningEffort: model.reasoningEffort,
			usage: result.usage,
			durationMs: Math.round(performance.now() - started)
		});
		const call = result.toolCalls.find((c) => c.toolName === 'submit_match');
		const number = (call?.input as { finding?: number | null } | undefined)?.finding;
		if (typeof number !== 'number') return null;
		return number >= 1 && number <= candidates.length ? number - 1 : null;
	};
}

export function judgePrompt(expected: ExpectedFinding, candidates: ReportedFinding[]): string {
	const [start, end] = expected.lines;
	const findings = candidates
		.map(
			(f, i) =>
				`<finding number="${i + 1}" lines="${f.startLine}-${f.endLine}" severity="${f.severity}" category="${f.category}">\n<title>${f.title}</title>\n${f.body}\n</finding>`
		)
		.join('\n');
	return `<problem path="${expected.path}" lines="${start}-${end}">\n${expected.issue}\n</problem>\n\n${findings}`;
}
