import { describe, expect, test } from 'bun:test';
import { defaultConfig } from './config';
import {
	reviewerInstructions,
	reviewPrompt,
	verifierInstructions,
	type PromptInput
} from './prompts';

const input: PromptInput = {
	pullRequest: { title: 'Fix login', body: '', author: 'octocat' },
	config: defaultConfig,
	guidelines: [{ path: 'AGENTS.md', content: 'Use tabs.' }],
	pathInstructions: [],
	diff: '### src/a.ts [modified, +1 -0]',
	notShown: [],
	alreadyReported: [],
	openFindings: []
};

describe('prompts', () => {
	test('the instructions mark pull request content as untrusted', () => {
		expect(reviewerInstructions(defaultConfig)).toContain('untrusted data');
		expect(verifierInstructions('balanced')).toContain('untrusted data');
	});

	test('the profile changes what is reported', () => {
		const strict = {
			...defaultConfig,
			reviews: { ...defaultConfig.reviews, profile: 'strict' as const }
		};
		expect(reviewerInstructions(strict)).toContain('Maintainability problems');
		expect(reviewerInstructions(defaultConfig)).not.toContain('Maintainability problems');
	});

	test('the prompt holds only the sections that have content', () => {
		const prompt = reviewPrompt(input);
		expect(prompt).toContain('<repository_guidelines>');
		expect(prompt).toContain('<description>\n(none)\n</description>');
		expect(prompt).not.toContain('<open_findings>');
		expect(prompt).not.toContain('<review_instructions>');
	});

	test('earlier findings and skipped files are listed', () => {
		const prompt = reviewPrompt({
			...input,
			diff: '',
			notShown: [{ path: 'old.ts', reason: 'deleted' }],
			openFindings: [
				{ id: 'x1', path: 'a.ts', startLine: 1, endLine: 2, title: 'Bug', body: 'Details' }
			]
		});
		expect(prompt).toContain('- old.ts (deleted)');
		expect(prompt).toContain('grep for them');
		expect(prompt).toContain('<finding id="x1" path="a.ts" lines="1-2">');
		expect(prompt).toContain('No changed file fits in this prompt');
	});
});
