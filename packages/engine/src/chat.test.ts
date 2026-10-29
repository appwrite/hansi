import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { runChat } from './chat';

let repoDir: string;
beforeAll(async () => {
	repoDir = await mkdtemp(join(tmpdir(), 'hans-chat-'));
	await writeFile(join(repoDir, 'a.ts'), 'export const a = 1;\n');
});
afterAll(() => rm(repoDir, { recursive: true, force: true }));

const usage = {
	inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 10, text: 10, reasoning: 0 }
};
type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateResult = Extract<NonNullable<MockOptions['doGenerate']>, unknown[]>[number];

const step = (
	content: GenerateResult['content'],
	unified: 'tool-calls' | 'stop'
): GenerateResult => ({
	content,
	finishReason: { unified, raw: unified },
	usage,
	warnings: []
});
const call = (toolName: string, input: unknown) => ({
	type: 'tool-call' as const,
	toolCallId: toolName,
	toolName,
	input: JSON.stringify(input)
});

test('answers, remembers preferences, and records finding outcomes', async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [
			step(
				[
					call('read_file', { path: 'a.ts' }),
					call('remember', { rule: 'Do not flag magic numbers in config files.' }),
					call('mark_finding', { status: 'dismissed', reason: 'Intentional constant' })
				],
				'tool-calls'
			),
			step([{ type: 'text' as const, text: 'Got it, I will skip those from now on.' }], 'stop')
		]
	});

	const remembered: string[] = [];
	const marked: string[] = [];
	const roles: string[] = [];
	const reply = await runChat({
		repoDir,
		repository: 'acme/api',
		headSha: 'abc123def',
		pullRequest: { title: 'Config', body: '', author: 'octocat' },
		diff: '',
		thread: [
			{ author: 'hans', body: 'Magic number on line 1.', fromBot: true },
			{ author: 'octocat', body: 'That is intentional, we never care about this.', fromBot: false }
		],
		focus: { path: 'a.ts', line: 1 },
		learnings: ['Prefer early returns.'],
		language: 'en',
		model: { model, provider: 'mock', modelId: 'mock-1' },
		onRemember: async (rule) => void remembered.push(rule),
		onMarkFinding: async (status) => void marked.push(status),
		onModelCall: (c) => void roles.push(c.role)
	});

	expect(reply).toBe('Got it, I will skip those from now on.');
	expect(JSON.stringify(model.doGenerateCalls)).toContain(
		'https://github.com/acme/api/blob/abc123def/<path>#L<start>-L<end>'
	);
	expect(remembered).toEqual(['Do not flag magic numbers in config files.']);
	expect(marked).toEqual(['dismissed']);
	expect(roles).toEqual(['chat']);
	const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
	expect(prompt).toContain('Prefer early returns.');
	expect(prompt).toContain('That is intentional');
	// The tool result of read_file is fed back to the model on the second step.
	expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('export const a = 1;');
});

test('mark_finding is only offered for threads about a finding', async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [step([{ type: 'text' as const, text: 'It returns 1.' }], 'stop')]
	});
	await runChat({
		repoDir,
		repository: 'acme/api',
		headSha: 'abc123def',
		pullRequest: { title: 'x', body: '', author: 'octocat' },
		diff: '',
		thread: [{ author: 'octocat', body: '@hans what does a return?', fromBot: false }],
		learnings: [],
		language: 'en',
		model: { model, provider: 'mock', modelId: 'mock-1' },
		onRemember: async () => {}
	});
	const toolNames = (model.doGenerateCalls[0]?.tools ?? []).map((t) => t.name);
	expect(toolNames).toContain('remember');
	expect(toolNames).not.toContain('mark_finding');
});

test('sends the chat model its reasoning effort', async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [step([{ type: 'text' as const, text: 'It returns 1.' }], 'stop')]
	});
	await runChat({
		repoDir,
		repository: 'acme/api',
		headSha: 'abc123def',
		pullRequest: { title: 'x', body: '', author: 'octocat' },
		diff: '',
		thread: [{ author: 'octocat', body: '@hans what does a return?', fromBot: false }],
		learnings: [],
		language: 'en',
		model: { model, provider: 'openai', modelId: 'gpt-5', reasoningEffort: 'minimal' },
		onRemember: async () => {}
	});
	expect(model.doGenerateCalls[0]).toMatchObject({ reasoning: 'minimal' });
});

const agentsDiff = `diff --git a/AGENTS.md b/AGENTS.md
index 1111111..2222222 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1,2 +1,3 @@
 # Guidelines
+- Contract locks may live under tests/unit.
 Tests live next to the code.
`;

async function promptFor(input: {
	authorAssociation: string;
	finding?: { severity: string; category: string; title: string };
	onMarkFinding?: boolean;
}) {
	const model = new MockLanguageModelV4({
		doGenerate: [step([{ type: 'text' as const, text: 'Understood.' }], 'stop')]
	});
	await runChat({
		repoDir,
		repository: 'appwrite/appwrite',
		headSha: 'd6ed431',
		pullRequest: { title: 'Scope lock', body: '', author: 'member' },
		diff: agentsDiff,
		thread: [
			{
				author: 'hansi',
				body: 'Keep config-contract checks outside the restricted unit tier.',
				fromBot: true
			},
			{
				author: 'member',
				body: 'Keeping it in the unit tier on purpose: it runs on every PR.',
				fromBot: false
			}
		],
		learnings: [],
		language: 'en',
		authorAssociation: input.authorAssociation,
		finding: input.finding,
		model: { model, provider: 'mock', modelId: 'mock-1' },
		onRemember: async () => {},
		onMarkFinding: input.onMarkFinding ? async () => {} : undefined
	});
	return (model.doGenerateCalls[0]?.prompt ?? [])
		.map((message) => {
			if (typeof message.content === 'string') return message.content;
			return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
		})
		.join('\n');
}

test('a trusted commenter is told to dismiss a minor testing note and the guideline edit', async () => {
	const prompt = await promptFor({
		authorAssociation: 'MEMBER',
		finding: {
			severity: 'minor',
			category: 'testing',
			title: 'Keep config-contract checks outside the restricted unit tier'
		},
		onMarkFinding: true
	});
	expect(prompt).toContain('<commenter association="MEMBER"/>');
	expect(prompt).toContain('category="testing"');
	expect(prompt).toContain('<guideline_edits>');
	expect(prompt).toContain('AGENTS.md');
	expect(prompt).toContain('dismissed on this first reply');
	expect(prompt).toContain('deferred to the policy change in this pull request');
	expect(prompt).toContain(
		'https://github.com/appwrite/appwrite/blob/d6ed431/<path>#L<start>-L<end>'
	);
});

test('an untrusted commenter is not told to accept the decline or the guideline edit', async () => {
	const prompt = await promptFor({
		authorAssociation: 'CONTRIBUTOR',
		finding: {
			severity: 'minor',
			category: 'testing',
			title: 'Keep config-contract checks outside the restricted unit tier'
		},
		onMarkFinding: true
	});
	expect(prompt).toContain('<commenter association="CONTRIBUTOR"/>');
	expect(prompt).toContain(
		'If the author says they fixed it, or convincingly explains it is not a problem, call mark_finding.'
	);
	expect(prompt).not.toContain('on this first reply');
	expect(prompt).not.toContain('deferred to the policy change');
	expect(prompt).toContain('Base-branch guidelines');
});
