import {
	generateText,
	isStepCount,
	ToolChoiceViolationError,
	type LanguageModelUsage,
	type ModelMessage,
	type ToolSet
} from 'ai';
import { reasoningCallOptions } from './model-call';
import type { ReviewModel } from './review';

/**
 * Stops once `toolName` was called with valid input. A call that does not match the schema, such
 * as an unknown category, gets the validation error back so the model can submit again.
 */
function validCall(toolName: string) {
	return ({ steps }: { steps: { toolCalls: { toolName: string; invalid?: boolean }[] }[] }) =>
		steps.at(-1)?.toolCalls.some((call) => call.toolName === toolName && !call.invalid) ?? false;
}

/**
 * Runs an agent loop that ends with a call to `toolName`. Out of steps, the last step may only
 * make that call, so the loop submits what it found so far instead of failing the whole review.
 *
 * Some models (or the provider routing them) ignore a forced tool choice and answer in text,
 * which the SDK rejects. Then the model gets one more turn, with the conversation so far and its
 * text answer, in which `toolName` is the only tool. If it still does not call it, the caller
 * sees no call and handles that like any other missing submission.
 */
export async function runToSubmission(
	toolName: string,
	maxSteps: number,
	model: ReviewModel,
	options: {
		instructions: string;
		prompt: ModelMessage[];
		tools: ToolSet;
		abortSignal?: AbortSignal;
	}
): Promise<{
	toolCalls: { toolName: string; input: unknown; invalid?: boolean }[];
	usage: LanguageModelUsage;
}> {
	const settings = { model: model.model, ...reasoningCallOptions(model), ...options };
	const messages: ModelMessage[] = [];
	let usage: LanguageModelUsage | undefined;
	try {
		return await generateText({
			...settings,
			stopWhen: [isStepCount(maxSteps), validCall(toolName)],
			prepareStep: ({ stepNumber }) =>
				stepNumber >= maxSteps - 1
					? { toolChoice: { type: 'tool', toolName }, activeTools: [toolName] }
					: undefined,
			// Every model call, including the one the SDK then rejects.
			onLanguageModelCallEnd: (call) => {
				usage = usage ? addUsage(usage, call.usage) : call.usage;
			},
			onStepEnd: (step) => void messages.push(...step.response.messages)
		});
	} catch (error) {
		if (!ToolChoiceViolationError.isInstance(error) || options.abortSignal?.aborted) throw error;
		const answer = error.content
			.flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text] : []))
			.join('\n');
		const retry = await generateText({
			...settings,
			prompt: [
				...options.prompt,
				...messages,
				...(answer ? [{ role: 'assistant' as const, content: answer }] : []),
				{
					role: 'user',
					content: `You answered in text. Call the ${toolName} tool now with your result; it is the only way to submit.`
				}
			],
			activeTools: [toolName],
			stopWhen: [isStepCount(2), validCall(toolName)]
		});
		return {
			toolCalls: retry.toolCalls,
			usage: usage ? addUsage(usage, retry.usage) : retry.usage
		};
	}
}

function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
	const add = (x?: number, y?: number) =>
		x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
	return {
		inputTokens: add(a.inputTokens, b.inputTokens),
		inputTokenDetails: {
			noCacheTokens: add(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
			cacheReadTokens: add(
				a.inputTokenDetails?.cacheReadTokens,
				b.inputTokenDetails?.cacheReadTokens
			),
			cacheWriteTokens: add(
				a.inputTokenDetails?.cacheWriteTokens,
				b.inputTokenDetails?.cacheWriteTokens
			)
		},
		outputTokens: add(a.outputTokens, b.outputTokens),
		outputTokenDetails: {
			textTokens: add(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
			reasoningTokens: add(
				a.outputTokenDetails?.reasoningTokens,
				b.outputTokenDetails?.reasoningTokens
			)
		},
		totalTokens: add(a.totalTokens, b.totalTokens)
	};
}
