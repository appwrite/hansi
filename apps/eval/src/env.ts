import { reasoningEfforts, type ReasoningEffort } from '@hansi/engine';
import {
	isProviderId,
	missingConfig,
	parseModelId,
	providerIds,
	type ModelEnv,
	type ProviderId
} from '@hansi/service/models';

// The eval reads the service's model variables, so a run reviews with what production would,
// and nothing else the service needs (Appwrite, the queue).

export interface EvalEnv extends ModelEnv {
	/** The judge's model; defaults to the verify model, then the review model. */
	HANSI_JUDGE_MODEL?: string;
	HANSI_ORCHESTRATOR_ENDPOINT?: string;
	HANSI_ORCHESTRATOR_KEY?: string;
	HANSI_SANDBOX_IMAGE?: string;
	HANSI_SANDBOX_RUNTIME_CLASS: 'runc' | 'gvisor' | 'kata';
}

const MODEL_VARIABLES = [
	'HANSI_REVIEW_MODEL',
	'HANSI_VERIFY_MODEL',
	'HANSI_BASIC_REVIEW_MODEL',
	'HANSI_BASIC_VERIFY_MODEL',
	'HANSI_EXPERT_REVIEW_MODEL',
	'HANSI_EXPERT_VERIFY_MODEL',
	'HANSI_JUDGE_MODEL'
] as const;

/** Reads and checks the variables; calls `fail` with every problem at once. */
export function loadEvalEnv(
	source: Record<string, string | undefined>,
	fail: (message: string) => never
): EvalEnv {
	const read = (name: string) => source[name]?.trim() || undefined;
	const problems: string[] = [];

	if (!read('HANSI_REVIEW_MODEL')) problems.push('HANSI_REVIEW_MODEL is required');
	const providers = new Set<ProviderId>();
	for (const name of MODEL_VARIABLES) {
		const id = read(name);
		if (!id) continue;
		const { provider, model } = parseModelId(id);
		if (!isProviderId(provider) || !model) {
			problems.push(`${name}: use provider:model, with a provider of ${providerIds.join(', ')}`);
		} else {
			providers.add(provider);
		}
	}

	const reasoning = (name: string): ReasoningEffort | undefined => {
		const value = read(name);
		if (value === undefined) return undefined;
		if ((reasoningEfforts as readonly string[]).includes(value)) return value as ReasoningEffort;
		problems.push(`${name}: one of ${reasoningEfforts.join(', ')}`);
		return undefined;
	};
	const runtimeClass = read('HANSI_SANDBOX_RUNTIME_CLASS') ?? 'gvisor';
	if (!['runc', 'gvisor', 'kata'].includes(runtimeClass)) {
		problems.push('HANSI_SANDBOX_RUNTIME_CLASS: one of runc, gvisor, kata');
	}

	const env: EvalEnv = {
		HANSI_REVIEW_MODEL: read('HANSI_REVIEW_MODEL') ?? '',
		HANSI_VERIFY_MODEL: read('HANSI_VERIFY_MODEL'),
		HANSI_BASIC_REVIEW_MODEL: read('HANSI_BASIC_REVIEW_MODEL'),
		HANSI_BASIC_VERIFY_MODEL: read('HANSI_BASIC_VERIFY_MODEL'),
		HANSI_EXPERT_REVIEW_MODEL: read('HANSI_EXPERT_REVIEW_MODEL'),
		HANSI_EXPERT_VERIFY_MODEL: read('HANSI_EXPERT_VERIFY_MODEL'),
		HANSI_JUDGE_MODEL: read('HANSI_JUDGE_MODEL'),
		HANSI_REVIEW_REASONING: reasoning('HANSI_REVIEW_REASONING'),
		HANSI_VERIFY_REASONING: reasoning('HANSI_VERIFY_REASONING'),
		HANSI_AI_SECRET: read('HANSI_AI_SECRET'),
		HANSI_AI_REGION: read('HANSI_AI_REGION'),
		HANSI_AI_BASE_URL: read('HANSI_AI_BASE_URL'),
		HANSI_ORCHESTRATOR_ENDPOINT: read('HANSI_ORCHESTRATOR_ENDPOINT'),
		HANSI_ORCHESTRATOR_KEY: read('HANSI_ORCHESTRATOR_KEY'),
		HANSI_SANDBOX_IMAGE: read('HANSI_SANDBOX_IMAGE'),
		HANSI_SANDBOX_RUNTIME_CLASS: runtimeClass as EvalEnv['HANSI_SANDBOX_RUNTIME_CLASS']
	};
	// As in the service: every model shares one HANSI_AI_SECRET, so they share the review
	// model's provider.
	const reviewProvider = parseModelId(env.HANSI_REVIEW_MODEL).provider;
	for (const name of MODEL_VARIABLES) {
		const id = read(name);
		if (id && name !== 'HANSI_REVIEW_MODEL' && parseModelId(id).provider !== reviewProvider) {
			problems.push(
				`${name}: use the review model's provider, ${reviewProvider}: there is one HANSI_AI_SECRET`
			);
		}
	}
	for (const provider of providers) {
		for (const missing of missingConfig(provider, env)) {
			problems.push(`${missing} is required for ${provider}`);
		}
	}
	if (problems.length) fail(problems.join('\n'));
	return env;
}
