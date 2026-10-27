import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { Env } from './env';
import type { Models } from './handlers';

// Model ids name their provider, as `provider:model` (`bedrock:global.anthropic.claude-…`).
// Both models use one provider and one credential, `HANSI_AI_SECRET`, the way Appwrite will hand
// one over once it serves model keys.

export const providerIds = [
	'openai',
	'anthropic',
	'xai',
	'google',
	'openrouter',
	'bedrock',
	'openai-compatible'
] as const;
export type ProviderId = (typeof providerIds)[number];

export function isProviderId(id: string): id is ProviderId {
	return (providerIds as readonly string[]).includes(id);
}

/** Splits `provider:model` on its first colon: Bedrock and Ollama model ids have their own. */
export function parseModelId(id: string): { provider: string; model: string } {
	const separator = id.indexOf(':');
	return separator === -1
		? { provider: '', model: id }
		: { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

/** The AI SDK's reasoning levels. Unset leaves the provider's default. */
export const reasoningEfforts = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max'
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export type BedrockAuth =
	{ apiKey: string } | { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/**
 * A Bedrock API key, or an IAM key pair written as `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]`,
 * told apart by the access key's AKIA (long-term) or ASIA (temporary) prefix.
 */
export function parseBedrockSecret(secret: string): BedrockAuth {
	const value = secret.trim();
	const [accessKeyId, secretAccessKey, ...session] = value.split(':');
	const iam = accessKeyId?.startsWith('AKIA') || accessKeyId?.startsWith('ASIA');
	if (!iam || !secretAccessKey) return { apiKey: value };
	const sessionToken = session.join(':');
	return { accessKeyId: accessKeyId!, secretAccessKey, ...(sessionToken && { sessionToken }) };
}

/** The variables the provider still needs, or none when it is ready. */
export function missingConfig(
	provider: ProviderId,
	env: Pick<Env, 'HANSI_AI_SECRET' | 'HANSI_AI_REGION' | 'HANSI_AI_BASE_URL'>
): string[] {
	switch (provider) {
		case 'bedrock':
			return [
				...(env.HANSI_AI_SECRET ? [] : ['HANSI_AI_SECRET']),
				...(env.HANSI_AI_REGION ? [] : ['HANSI_AI_REGION'])
			];
		case 'openai-compatible':
			// Local servers often take no key.
			return env.HANSI_AI_BASE_URL ? [] : ['HANSI_AI_BASE_URL'];
		default:
			return env.HANSI_AI_SECRET ? [] : ['HANSI_AI_SECRET'];
	}
}

/** The provider's model, with the credential from the environment. */
export function createLanguageModel(
	env: Env,
	id: string,
	reasoning?: ReasoningEffort
): LanguageModel {
	const { provider } = parseModelId(id);
	const model = providerModel(env, id);
	if (!reasoning) return model;
	return wrapLanguageModel({
		model,
		middleware: {
			// OpenRouter reads the effort from its own options, the others from the shared setting.
			transformParams: async ({ params }) =>
				provider === 'openrouter'
					? {
							...params,
							providerOptions: {
								...params.providerOptions,
								openrouter: {
									...params.providerOptions?.openrouter,
									reasoning: { effort: reasoning }
								}
							}
						}
					: { ...params, reasoning }
		}
	});
}

function providerModel(env: Env, id: string) {
	const { provider, model } = parseModelId(id);
	const apiKey = env.HANSI_AI_SECRET;
	const baseURL = env.HANSI_AI_BASE_URL;

	switch (provider as ProviderId) {
		case 'openai':
			return createOpenAI({ apiKey, baseURL })(model);
		case 'anthropic':
			return createAnthropic({ apiKey, baseURL })(model);
		case 'xai':
			return createXai({ apiKey, baseURL })(model);
		case 'google':
			return createGoogle({ apiKey, baseURL })(model);
		case 'openrouter':
			return createOpenRouter({ apiKey, baseURL })(model);
		case 'bedrock':
			return createAmazonBedrock({
				region: env.HANSI_AI_REGION,
				baseURL,
				...parseBedrockSecret(apiKey ?? '')
			})(model);
		case 'openai-compatible':
			return createOpenAICompatible({ name: 'openai-compatible', apiKey, baseURL: baseURL! })(
				model
			);
	}
}

export function createModels(env: Env): Models {
	return {
		reviewer: createLanguageModel(env, env.HANSI_REVIEW_MODEL, env.HANSI_REVIEW_REASONING),
		verifier:
			env.HANSI_VERIFY_MODEL || env.HANSI_VERIFY_REASONING
				? createLanguageModel(
						env,
						env.HANSI_VERIFY_MODEL ?? env.HANSI_REVIEW_MODEL,
						env.HANSI_VERIFY_REASONING ?? env.HANSI_REVIEW_REASONING
					)
				: undefined
	};
}
