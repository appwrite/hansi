import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createProviderRegistry } from 'ai';
import type { Env } from './env';
import type { Models } from './handlers';

// Model ids name their provider, as `provider:model` (`bedrock:global.anthropic.claude-…`).
// Each provider takes its credentials from `HANSI_<PROVIDER>_*`; `parseEnv` refuses a model
// whose provider is not configured, so a missing key fails the start, not the first review.

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

export function providerOf(modelId: string): string {
	const separator = modelId.indexOf(':');
	return separator === -1 ? '' : modelId.slice(0, separator);
}

export function isProviderId(id: string): id is ProviderId {
	return (providerIds as readonly string[]).includes(id);
}

type ProviderEnv = Omit<Env, 'HANSI_REVIEW_MODEL' | 'HANSI_VERIFY_MODEL'>;

/** The variables a provider still needs, or none when it is ready. */
export function missingConfig(provider: ProviderId, env: Partial<ProviderEnv>): string[] {
	switch (provider) {
		case 'openai':
			return env.HANSI_OPENAI_API_KEY ? [] : ['HANSI_OPENAI_API_KEY'];
		case 'anthropic':
			return env.HANSI_ANTHROPIC_API_KEY ? [] : ['HANSI_ANTHROPIC_API_KEY'];
		case 'xai':
			return env.HANSI_XAI_API_KEY ? [] : ['HANSI_XAI_API_KEY'];
		case 'google':
			return env.HANSI_GOOGLE_API_KEY ? [] : ['HANSI_GOOGLE_API_KEY'];
		case 'openrouter':
			return env.HANSI_OPENROUTER_API_KEY ? [] : ['HANSI_OPENROUTER_API_KEY'];
		case 'bedrock': {
			const missing = env.HANSI_BEDROCK_REGION ? [] : ['HANSI_BEDROCK_REGION'];
			// A Bedrock API key, or an IAM access key pair.
			if (env.HANSI_BEDROCK_API_KEY) return missing;
			if (!env.HANSI_BEDROCK_ACCESS_KEY_ID && !env.HANSI_BEDROCK_SECRET_ACCESS_KEY) {
				return [...missing, 'HANSI_BEDROCK_API_KEY'];
			}
			if (!env.HANSI_BEDROCK_ACCESS_KEY_ID) missing.push('HANSI_BEDROCK_ACCESS_KEY_ID');
			if (!env.HANSI_BEDROCK_SECRET_ACCESS_KEY) missing.push('HANSI_BEDROCK_SECRET_ACCESS_KEY');
			return missing;
		}
		case 'openai-compatible':
			return env.HANSI_OPENAI_COMPATIBLE_BASE_URL ? [] : ['HANSI_OPENAI_COMPATIBLE_BASE_URL'];
	}
}

/**
 * The providers, built from the environment. Building one calls nothing and checks no key, so
 * the providers no model uses cost nothing.
 */
export function createRegistry(env: ProviderEnv) {
	return createProviderRegistry({
		openai: createOpenAI({ apiKey: env.HANSI_OPENAI_API_KEY, baseURL: env.HANSI_OPENAI_BASE_URL }),
		anthropic: createAnthropic({
			apiKey: env.HANSI_ANTHROPIC_API_KEY,
			baseURL: env.HANSI_ANTHROPIC_BASE_URL
		}),
		xai: createXai({ apiKey: env.HANSI_XAI_API_KEY, baseURL: env.HANSI_XAI_BASE_URL }),
		google: createGoogle({
			apiKey: env.HANSI_GOOGLE_API_KEY,
			baseURL: env.HANSI_GOOGLE_BASE_URL
		}),
		openrouter: createOpenRouter({
			apiKey: env.HANSI_OPENROUTER_API_KEY,
			baseURL: env.HANSI_OPENROUTER_BASE_URL
		}),
		bedrock: createAmazonBedrock({
			region: env.HANSI_BEDROCK_REGION,
			// The provider prefers the API key, and signs with the key pair without one.
			apiKey: env.HANSI_BEDROCK_API_KEY,
			accessKeyId: env.HANSI_BEDROCK_ACCESS_KEY_ID,
			secretAccessKey: env.HANSI_BEDROCK_SECRET_ACCESS_KEY,
			sessionToken: env.HANSI_BEDROCK_SESSION_TOKEN
		}),
		// It has no default endpoint, so it exists only with one; parseEnv requires it to be used.
		...(env.HANSI_OPENAI_COMPATIBLE_BASE_URL && {
			'openai-compatible': createOpenAICompatible({
				name: 'openai-compatible',
				baseURL: env.HANSI_OPENAI_COMPATIBLE_BASE_URL,
				apiKey: env.HANSI_OPENAI_COMPATIBLE_API_KEY
			})
		})
	});
}

export function createModels(env: Env): Models {
	const registry = createRegistry(env);
	return {
		reviewer: registry.languageModel(env.HANSI_REVIEW_MODEL as `${ProviderId}:${string}`),
		verifier: env.HANSI_VERIFY_MODEL
			? registry.languageModel(env.HANSI_VERIFY_MODEL as `${ProviderId}:${string}`)
			: undefined
	};
}
