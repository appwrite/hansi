import { describe, expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { runToSubmission } from './agent';
import type { ModelUsage } from './results';
import { scriptedModel } from './testing';

const submit = {
	name: 'submit',
	description: 'Submit the answer.',
	schema: z.object({ answer: z.string() })
};

const lookups: string[] = [];
const tools = {
	lookup: tool({
		description: 'Look something up.',
		inputSchema: z.object({ key: z.string() }),
		execute: async ({ key }) => {
			lookups.push(key);
			return `value of ${key}`;
		}
	})
};

const base = { role: 'test', instructions: 'Answer.', prompt: 'What is x?', tools, submit };

describe('runToSubmission', () => {
	test('runs tools until the model submits', async () => {
		const usage: ModelUsage[] = [];
		const model = scriptedModel([
			{ calls: [{ tool: 'lookup', input: { key: 'x' } }] },
			{ calls: [{ tool: 'submit', input: { answer: '42' } }] }
		]);
		const result = await runToSubmission({
			...base,
			model,
			maxSteps: 5,
			usage: (u) => usage.push(u)
		});
		expect(result).toEqual({ answer: '42' });
		expect(lookups).toContain('x');
		expect(model.doGenerateCalls).toHaveLength(2);
		expect(usage[0]).toMatchObject({
			role: 'test',
			provider: 'scripted',
			model: 'scripted-model',
			inputTokens: 100,
			outputTokens: 10,
			cachedInputTokens: 20,
			reasoningTokens: 2
		});
	});

	test('forces the submit tool on the last step', async () => {
		const model = scriptedModel([
			{ calls: [{ tool: 'lookup', input: { key: 'a' } }] },
			{ calls: [{ tool: 'submit', input: { answer: 'late' } }] }
		]);
		expect(await runToSubmission({ ...base, model, maxSteps: 2 })).toEqual({ answer: 'late' });
		expect(model.doGenerateCalls[0]!.toolChoice).not.toEqual({ type: 'tool', toolName: 'submit' });
		expect(model.doGenerateCalls[1]!.toolChoice).toEqual({ type: 'tool', toolName: 'submit' });
	});

	test('nudges a model that stops without submitting', async () => {
		const events: string[] = [];
		const model = scriptedModel([
			{ text: 'I think the answer is 42.' },
			{ calls: [{ tool: 'submit', input: { answer: '42' } }] }
		]);
		const result = await runToSubmission({
			...base,
			model,
			maxSteps: 5,
			emit: (type) => events.push(type)
		});
		expect(result).toEqual({ answer: '42' });
		expect(events).toContain('test.nudge');
		expect(model.doGenerateCalls[1]!.toolChoice).toEqual({ type: 'tool', toolName: 'submit' });
	});

	test('returns null when the model never submits', async () => {
		const model = scriptedModel([
			{ text: 'No.' },
			{ calls: [{ tool: 'submit', input: { wrong: true } }] },
			{ calls: [{ tool: 'submit', input: { wrong: true } }] }
		]);
		expect(await runToSubmission({ ...base, model, maxSteps: 5 })).toBeNull();
	});
});
