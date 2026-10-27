import {
	generateText,
	hasToolCall,
	isStepCount,
	tool,
	ToolChoiceViolationError,
	type LanguageModel,
	type ModelMessage,
	type ToolSet
} from 'ai';
import type { z } from 'zod';
import type { ModelUsage } from './results';
import type { Emit } from './tools';

// One agent loop: the model works with its tools until it calls the submit tool, which carries
// the result. Models sometimes stop talking without submitting, so the last step forces the
// submit tool, and a run that still ends empty gets one more forced call.

export interface SubmissionOptions<S extends z.ZodType> {
	/** `review`, `verify`, …: tags events and usage. */
	role: string;
	model: LanguageModel;
	instructions: string;
	prompt: string;
	tools: ToolSet;
	submit: { name: string; description: string; schema: S };
	maxSteps: number;
	emit?: Emit;
	usage?: (usage: ModelUsage) => void;
	signal?: AbortSignal;
}

/** The first submission, or null when the model never made a valid one. */
export async function runToSubmission<S extends z.ZodType>(
	options: SubmissionOptions<S>
): Promise<z.infer<S> | null> {
	const { role, submit } = options;
	const emit: Emit = options.emit ?? (() => {});
	let submitted: z.infer<S> | null = null;

	const submitTool = tool({
		description: submit.description,
		inputSchema: submit.schema,
		execute: async (input: z.infer<S>) => {
			submitted ??= input;
			return 'Submitted.';
		}
	});
	const tools: ToolSet = { ...options.tools, [submit.name]: submitTool };
	const forced = {
		toolChoice: { type: 'tool', toolName: submit.name },
		activeTools: [submit.name]
	};

	// What the latest step was sent, so a run that throws can still be continued from it.
	let sent: ModelMessage[] = [];
	const call = (messages: ModelMessage[], maxSteps: number) =>
		generateText({
			model: options.model,
			instructions: options.instructions,
			messages,
			tools,
			stopWhen: [hasToolCall(submit.name), isStepCount(maxSteps)],
			prepareStep: ({ stepNumber, messages }) => {
				sent = messages;
				return stepNumber >= maxSteps - 1 ? forced : {};
			},
			abortSignal: options.signal,
			onStepEnd: (step) =>
				emit(`${role}.step`, {
					step: step.stepNumber,
					tools: step.toolCalls.map((call) => call.toolName)
				}),
			onLanguageModelCallEnd: (event) =>
				options.usage?.({
					role,
					provider: event.provider,
					model: event.modelId,
					inputTokens: event.usage.inputTokens ?? 0,
					outputTokens: event.usage.outputTokens ?? 0,
					cachedInputTokens: event.usage.inputTokenDetails.cacheReadTokens,
					reasoningTokens: event.usage.outputTokenDetails.reasoningTokens,
					durationMs: event.performance.responseTimeMs
				})
		});

	const messages: ModelMessage[] = [{ role: 'user', content: options.prompt }];
	let history: ModelMessage[];
	try {
		const result = await call(messages, options.maxSteps);
		history = [...messages, ...result.response.messages];
	} catch (error) {
		// The provider ignored the forced submit tool on the last step.
		if (!ToolChoiceViolationError.isInstance(error)) throw error;
		emit(`${role}.tool_choice_violation`, { attempt: -1 });
		history = sent;
	}
	if (submitted !== null) return submitted;

	// The model stopped early or sent an invalid submission. One forced call, retried once when
	// the provider ignores the forced tool choice.
	emit(`${role}.nudge`, {});
	const nudge: ModelMessage[] = [
		...history,
		{
			role: 'user',
			content: `You have not called ${submit.name} with a valid input yet. Call it now with what you found.`
		}
	];
	for (let attempt = 0; attempt < 2 && submitted === null; attempt++) {
		try {
			await call(nudge, 1);
		} catch (error) {
			if (!ToolChoiceViolationError.isInstance(error)) throw error;
			emit(`${role}.tool_choice_violation`, { attempt });
		}
	}
	return submitted;
}
