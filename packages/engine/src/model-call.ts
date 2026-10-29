import type { ReasoningEffort } from './config';
import {
	APICallError,
	RetryError,
	type LanguageModelUsage,
	type ModelMessage,
	type UserModelMessage
} from 'ai';

/** A model call that finished: what it used, for cost tracking. */
export interface ModelCall {
	role: 'review' | 'verify' | 'chat';
	provider: string;
	modelId: string;
	/** The effort the call was made with; null or absent means the provider's default. */
	reasoningEffort?: ReasoningEffort | null;
	usage: LanguageModelUsage;
	durationMs: number;
}

/** A model call that failed, e.g. a rate limit, timeout, or rejected key. */
export interface ModelFailure {
	role: ModelCall['role'];
	provider: string;
	modelId: string;
	durationMs: number;
	message: string;
	/** HTTP status from the provider, when there was a response. */
	status?: number;
}

export interface ModelCallHooks {
	onModelCall?: (call: ModelCall) => void | Promise<void>;
	onModelError?: (failure: ModelFailure) => void | Promise<void>;
	signal?: AbortSignal;
}

/**
 * Runs one model call and reports it: its usage when it finishes, or the error when it fails
 * (then rethrows). Calls cancelled through `signal` are not reported as failures.
 */
export async function callModel<T extends { usage: LanguageModelUsage }>(
	role: ModelCall['role'],
	model: { provider: string; modelId: string; reasoningEffort?: ReasoningEffort | null },
	hooks: ModelCallHooks,
	run: () => Promise<T>
): Promise<T> {
	const started = performance.now();
	const durationMs = () => Math.round(performance.now() - started);
	const { provider, modelId } = model;
	let result: T;
	try {
		result = await run();
	} catch (error) {
		if (!hooks.signal?.aborted) {
			await Promise.resolve(
				hooks.onModelError?.({
					role,
					provider,
					modelId,
					durationMs: durationMs(),
					...describeModelError(error)
				})
			).catch(() => {});
		}
		throw error;
	}
	await hooks.onModelCall?.({
		role,
		provider,
		modelId,
		reasoningEffort: model.reasoningEffort ?? null,
		usage: result.usage,
		durationMs: durationMs()
	});
	return result;
}

/**
 * Settings for one model call. Official providers take the shared `reasoning` parameter.
 * OpenRouter only reads the effort from its own options.
 */
export function reasoningCallOptions(model: {
	provider: string;
	reasoningEffort?: ReasoningEffort | null;
}): {
	reasoning?: ReasoningEffort;
	providerOptions?: { openrouter: { reasoning: { effort: ReasoningEffort } } };
} {
	const effort = model.reasoningEffort;
	if (!effort) return {};
	if (model.provider === 'openrouter') {
		return { providerOptions: { openrouter: { reasoning: { effort } } } };
	}
	return { reasoning: effort };
}

/** Bedrock models that support prompt caching; others may reject a cache point. */
const BEDROCK_CACHING = /anthropic\.claude-(3-7|3-5-haiku|(sonnet|opus|haiku)-\d)|amazon\.nova/;

/**
 * The prompt as one user message, marked for caching on providers that only cache when asked.
 * An agent loop re-sends it, and the instructions and tools before it, on every step.
 */
export function cachedPrompt(
	model: { provider: string; modelId: string },
	text: string
): ModelMessage[] {
	const providerOptions: UserModelMessage['providerOptions'] =
		model.provider === 'anthropic'
			? { anthropic: { cacheControl: { type: 'ephemeral' } } }
			: model.provider === 'amazon-bedrock' && BEDROCK_CACHING.test(model.modelId)
				? { bedrock: { cachePoint: { type: 'default' } } }
				: undefined;
	return [{ role: 'user', content: text, ...(providerOptions && { providerOptions }) }];
}

/** The message and HTTP status of a model error, looking through the SDK's retry wrapper. */
export function describeModelError(error: unknown): { message: string; status?: number } {
	const cause = RetryError.isInstance(error) ? (error.lastError ?? error) : error;
	const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
	return APICallError.isInstance(cause) && cause.statusCode
		? { message, status: cause.statusCode }
		: { message };
}
