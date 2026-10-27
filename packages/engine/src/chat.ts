import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { runToSubmission } from './agent';
import type { RepoConfig } from './config';
import type { FileDiff } from './diff';
import { filterFiles } from './filters';
import { chatInstructions, chatPrompt, type ChatPromptInput } from './prompts';
import type { ModelUsage } from './results';
import { fitDiff, matchingPathInstructions } from './review';
import { createRepoTools, loadGuidelines, type Emit } from './tools';

// One answer to one comment on a pull request: the model reads the conversation and the code
// with the read-only tools and writes a reply. Posting it happens outside.

/** Diff characters the prompt holds: less than a review, as the question is usually narrow. */
export const CHAT_DIFF_BUDGET = 60_000;
export const CHAT_STEPS = 20;

export interface ChatInput {
	/** Checkout of the pull request head. The base commit must be in its object store. */
	repoDir: string;
	baseSha: string;
	token?: string;
	pullRequest: ChatPromptInput['pullRequest'];
	files: FileDiff[];
	config: RepoConfig;
	thread?: ChatPromptInput['thread'];
	conversation: ChatPromptInput['conversation'];
	question: ChatPromptInput['question'];
}

export interface ChatOptions {
	model: LanguageModel;
	emit?: Emit;
	usage?: (usage: ModelUsage) => void;
	signal?: AbortSignal;
}

const replySubmission = z.object({ body: z.string().trim().min(1) });

/** The reply to post. */
export async function runChat(input: ChatInput, options: ChatOptions): Promise<string> {
	const { config, repoDir } = input;
	const emit: Emit = options.emit ?? (() => {});
	const { included, excluded } = filterFiles(input.files, config.reviews.paths);
	const { diff, over } = fitDiff(included, CHAT_DIFF_BUDGET);
	const notShown = [
		...excluded,
		...over.map((file) => ({ path: file.path, reason: 'too large to show' }))
	];
	const guidelines = await loadGuidelines(repoDir, input.baseSha, input.token);

	const submission = await runToSubmission({
		role: 'chat',
		model: options.model,
		instructions: chatInstructions(config),
		prompt: chatPrompt({
			pullRequest: input.pullRequest,
			config,
			guidelines,
			pathInstructions: matchingPathInstructions(config, included),
			diff,
			notShown,
			thread: input.thread,
			conversation: input.conversation,
			question: input.question
		}),
		tools: createRepoTools(repoDir, { emit, baseSha: input.baseSha, token: input.token }),
		submit: {
			name: 'submit_reply',
			description: 'Submit the reply to post. Call it exactly once, at the end.',
			schema: replySubmission
		},
		maxSteps: CHAT_STEPS,
		emit,
		usage: options.usage,
		signal: options.signal
	});
	if (!submission) throw new Error('The model did not submit a reply');
	return submission.body;
}
