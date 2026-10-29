import { expect, test } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import {
	cachedPrompt,
	callModel,
	reasoningCallOptions,
	type ModelCall,
	type ModelFailure
} from './model-call';

const model = { provider: 'anthropic', modelId: 'claude-sonnet-5' };

function rateLimited() {
	const last = new APICallError({
		message: 'Rate limit exceeded',
		url: 'https://api.anthropic.com/v1/messages',
		requestBodyValues: {},
		statusCode: 429
	});
	return new RetryError({
		message: 'Failed after 3 attempts',
		reason: 'maxRetriesExceeded',
		errors: [last]
	});
}

test('reports usage when a call finishes', async () => {
	const calls: ModelCall[] = [];
	const result = await callModel(
		'review',
		model,
		{ onModelCall: (c) => void calls.push(c) },
		async () => ({
			usage: { inputTokens: 10, outputTokens: 2 } as never,
			text: 'ok'
		})
	);
	expect(result.text).toBe('ok');
	expect(calls).toMatchObject([
		{
			role: 'review',
			modelId: 'claude-sonnet-5',
			reasoningEffort: null,
			usage: { inputTokens: 10 }
		}
	]);
});

test('reports the reasoning effort the call was made with', async () => {
	const calls: ModelCall[] = [];
	await callModel(
		'verify',
		{ ...model, reasoningEffort: 'high' },
		{ onModelCall: (c) => void calls.push(c) },
		async () => ({ usage: { inputTokens: 1, outputTokens: 1 } as never })
	);
	expect(calls).toMatchObject([{ role: 'verify', reasoningEffort: 'high' }]);
});

test('reports a failure with the provider status, then rethrows', async () => {
	const failures: ModelFailure[] = [];
	const call = callModel('verify', model, { onModelError: (f) => void failures.push(f) }, () =>
		Promise.reject(rateLimited())
	);
	expect(call).rejects.toBeInstanceOf(RetryError);
	await call.catch(() => {});
	expect(failures).toMatchObject([
		{ role: 'verify', provider: 'anthropic', message: 'Rate limit exceeded', status: 429 }
	]);
});

test('passes a reasoning effort, and OpenRouter gets it in its own options', () => {
	expect(reasoningCallOptions({ provider: 'anthropic' })).toEqual({});
	expect(reasoningCallOptions({ provider: 'anthropic', reasoningEffort: null })).toEqual({});
	expect(reasoningCallOptions({ provider: 'openai', reasoningEffort: 'high' })).toEqual({
		reasoning: 'high'
	});
	expect(reasoningCallOptions({ provider: 'openrouter', reasoningEffort: 'low' })).toEqual({
		providerOptions: { openrouter: { reasoning: { effort: 'low' } } }
	});
});

test('marks the prompt for caching where the provider needs asking', () => {
	const options = (provider: string, modelId: string) =>
		cachedPrompt({ provider, modelId }, 'Review this.')[0]?.providerOptions;
	expect(cachedPrompt(model, 'Review this.')).toEqual([
		{
			role: 'user',
			content: 'Review this.',
			providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
		}
	]);
	const bedrock = { bedrock: { cachePoint: { type: 'default' } } };
	expect(options('amazon-bedrock', 'us.anthropic.claude-sonnet-4-20250514-v1:0')).toEqual(bedrock);
	expect(options('amazon-bedrock', 'anthropic.claude-3-7-sonnet-20250219-v1:0')).toEqual(bedrock);
	expect(options('amazon-bedrock', 'amazon.nova-pro-v1:0')).toEqual(bedrock);
	expect(options('amazon-bedrock', 'anthropic.claude-3-sonnet-20240229-v1:0')).toBeUndefined();
	expect(options('amazon-bedrock', 'meta.llama3-70b-instruct-v1:0')).toBeUndefined();
	// OpenAI and others cache automatically.
	expect(options('openai', 'gpt-5')).toBeUndefined();
});

test('a cancelled call is not a failure', async () => {
	const controller = new AbortController();
	controller.abort();
	const failures: ModelFailure[] = [];
	const call = callModel(
		'chat',
		model,
		{ signal: controller.signal, onModelError: (f) => void failures.push(f) },
		() => Promise.reject(new Error('aborted'))
	);
	await call.catch(() => {});
	expect(failures).toEqual([]);
});
