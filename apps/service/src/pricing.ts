import type { LanguageModelUsage } from 'ai';

// Ported from hansi.codes (packages/llm/src/pricing.ts) as it is, so costs read the same in both.
// Only the provider lookup differs: hansi.codes reads it from its provider table.

/** models.dev's provider ids, by the provider a `ReviewModel` names. */
const modelsDevIds: Record<string, string> = {
	openai: 'openai',
	anthropic: 'anthropic',
	xai: 'xai',
	google: 'google',
	openrouter: 'openrouter',
	'amazon-bedrock': 'amazon-bedrock'
};

/** USD per million tokens, as published by models.dev. */
export interface ModelPrice {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

export type PriceCatalog = Record<string, Record<string, ModelPrice>>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cached: { catalog: PriceCatalog; fetchedAt: number } | undefined;

/** Fetches and caches the models.dev price catalog. Returns an empty catalog when offline. */
export async function loadPriceCatalog(fetchImpl: typeof fetch = fetch): Promise<PriceCatalog> {
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.catalog;

	try {
		const response = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
		const data = (await response.json()) as Record<
			string,
			{ models?: Record<string, { cost?: ModelPrice }> }
		>;

		const catalog: PriceCatalog = {};
		for (const [providerId, provider] of Object.entries(data)) {
			const prices: Record<string, ModelPrice> = {};
			for (const [modelId, model] of Object.entries(provider.models ?? {})) {
				if (model.cost) prices[modelId] = model.cost;
			}
			catalog[providerId] = prices;
		}
		cached = { catalog, fetchedAt: Date.now() };
		return catalog;
	} catch {
		return cached?.catalog ?? {};
	}
}

function lookupPrice(
	prices: Record<string, ModelPrice> | undefined,
	modelId: string
): ModelPrice | undefined {
	if (!prices) return undefined;
	// Some providers report dated snapshots (`gpt-x-2026-01-01`) that models.dev lists undated.
	return prices[modelId] ?? prices[modelId.replace(/-\d{4}-?\d{2}-?\d{2}$/, '')];
}

/** Keeps published per-million rates and drops catalog-only fields such as context tiers. */
function rates(price: ModelPrice): ModelPrice {
	return {
		input: price.input,
		output: price.output,
		...(price.cache_read == null ? {} : { cache_read: price.cache_read }),
		...(price.cache_write == null ? {} : { cache_write: price.cache_write })
	};
}

function scaleRates(price: ModelPrice, factor: number): ModelPrice {
	const scale = (value: number) => Math.round(value * factor * 1_000_000) / 1_000_000;
	const scaled = rates(price);
	return {
		input: scale(scaled.input),
		output: scale(scaled.output),
		...(scaled.cache_read == null ? {} : { cache_read: scale(scaled.cache_read) }),
		...(scaled.cache_write == null ? {} : { cache_write: scale(scaled.cache_write) })
	};
}

/**
 * models.dev lags new Bedrock launches. OpenAI models there are billed at OpenAI Standard rates
 * on a global inference profile, and at a 10% premium in-region and on geographic profiles.
 * GovCloud is a different premium, so those ids are left unpriced until models.dev lists them.
 */
function bedrockOpenAiPrice(catalog: PriceCatalog, modelId: string): ModelPrice | undefined {
	const id = modelId.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
	if (id.startsWith('us-gov.')) return undefined;

	let regional = true;
	let rest = id;
	if (rest.startsWith('global.')) {
		regional = false;
		rest = rest.slice('global.'.length);
	} else {
		const geo = /^(?:us|eu|apac|jp|au|in|ca)\./.exec(rest);
		if (geo) rest = rest.slice(geo[0].length);
	}
	if (!rest.startsWith('openai.')) return undefined;

	const base = lookupPrice(catalog.openai, rest.slice('openai.'.length));
	if (!base) return undefined;
	return regional ? scaleRates(base, 1.1) : rates(base);
}

export function findPrice(
	catalog: PriceCatalog,
	provider: string,
	modelId: string
): ModelPrice | undefined {
	const providerId = modelsDevIds[provider];
	if (!providerId) return undefined;
	return (
		lookupPrice(catalog[providerId], modelId) ??
		(provider === 'amazon-bedrock' ? bedrockOpenAiPrice(catalog, modelId) : undefined)
	);
}

/** Cost in USD, or `null` when the model has no known price. */
export function estimateCost(
	price: ModelPrice | undefined,
	usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> & {
		inputTokenDetails?: Partial<LanguageModelUsage['inputTokenDetails']>;
	}
): number | null {
	if (!price) return null;
	const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
	const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
	const uncachedInput = Math.max((usage.inputTokens ?? 0) - cacheRead - cacheWrite, 0);

	const cost =
		uncachedInput * price.input +
		cacheRead * (price.cache_read ?? price.input) +
		cacheWrite * (price.cache_write ?? price.input) +
		(usage.outputTokens ?? 0) * price.output;
	return cost / 1_000_000;
}
