/**
 * How much a model thinks before it answers: the levels the AI SDK accepts on
 * `generateText({ reasoning })`. Absent means the provider's own default.
 */
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
