import { generateText, isStepCount, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { parseUnifiedDiff, renderFileDiff } from './diff';
import { dependencyChanges, formatDependencyChanges } from './dependencies';
import { filterFiles } from './filters';
import { chatInstructions, formatChatContext, type ChatReplyContext } from './prompts';
import { callModel, reasoningCallOptions, type ModelCall, type ModelFailure } from './model-call';
import type { ReviewModel } from './review';
import {
	changedGuidelineFiles,
	createRepoTools,
	loadRepoGuidelines,
	type EmitEvent,
	type TrustedSource
} from './tools';
import { createSandboxTools, SANDBOX_GUIDANCE, type CommandRunner } from './sandbox';

export interface ThreadMessage {
	author: string;
	body: string;
	/** True for messages Hansi wrote. */
	fromBot: boolean;
}

export interface ChatInput {
	repoDir: string;
	/** `owner/name`. File permalinks in the reply use this repository. */
	repository: string;
	/** Commit the reply is about. File permalinks point at this SHA. */
	headSha: string;
	pullRequest: { title: string; body: string; author: string };
	/** Full PR diff, for context. */
	diff: string;
	/** Conversation so far, oldest first; the last message is the one to answer. */
	thread: ThreadMessage[];
	/** Set when the conversation is attached to a line of code. */
	focus?: { path: string; line?: number; diffHunk?: string };
	learnings: string[];
	language: string;
	/** GitHub `author_association` of the comment being answered. Missing means untrusted. */
	authorAssociation?: string;
	/** Set when this thread is a reply on a finding Hansi posted. */
	finding?: { severity: string; category: string; title: string };
	/** Where to read repository guidelines from; defaults to the (untrusted) PR checkout. */
	trustedSource?: TrustedSource;
	/** Where `run_command` runs, when the organization allows a sandbox. */
	sandbox?: CommandRunner;
	model: ReviewModel;
	/** Stores a team preference for future reviews. */
	onRemember: (rule: string) => Promise<void>;
	/** Available when the thread started from a Hansi finding. */
	onMarkFinding?: (status: 'resolved' | 'dismissed', reason: string) => Promise<void>;
	onEvent?: EmitEvent;
	onModelCall?: (call: ModelCall) => void | Promise<void>;
	onModelError?: (failure: ModelFailure) => void | Promise<void>;
	signal?: AbortSignal;
}

const MAX_DIFF_CHARS = 60_000;

/** Answers a question in a pull request conversation. Returns the reply as Markdown. */
export async function runChat(input: ChatInput): Promise<string> {
	const emit: EmitEvent = input.onEvent ?? (() => {});
	const tools: ToolSet = {
		...createRepoTools(input.repoDir, emit, {
			token: input.trustedSource?.token,
			baseRef: input.trustedSource?.ref
		}),
		...(input.sandbox ? createSandboxTools(input.sandbox, emit) : {}),
		remember: tool({
			description:
				'Save a lasting team preference for future reviews of this repository, e.g. "Do not flag missing error handling in scripts/". Only use when the user states a durable rule, not for one-off decisions.',
			inputSchema: z.object({
				rule: z.string().describe('One imperative sentence, understandable without this thread')
			}),
			execute: async ({ rule }) => {
				emit({ type: 'chat.remember', data: { rule } });
				await input.onRemember(rule);
				return 'Saved. Future reviews will follow this.';
			}
		})
	};
	if (input.onMarkFinding) {
		const onMarkFinding = input.onMarkFinding;
		tools.mark_finding = tool({
			description:
				'Record the outcome of the finding this thread is about: resolved (the author fixed it) or dismissed (it was wrong, not wanted, or settled by a trusted maintainer declining a minor testing, documentation, or maintainability note).',
			inputSchema: z.object({
				status: z.enum(['resolved', 'dismissed']),
				reason: z.string()
			}),
			execute: async ({ status, reason }) => {
				emit({ type: 'chat.mark_finding', data: { status, reason } });
				await onMarkFinding(status, reason);
				return `Marked as ${status}.`;
			}
		});
	}

	const parsed = parseUnifiedDiff(input.diff);
	const replyContext: ChatReplyContext = {
		authorAssociation: input.authorAssociation,
		finding: input.finding,
		changedGuidelines: changedGuidelineFiles(parsed)
	};
	let diff = filterFiles(parsed).included.map(renderFileDiff).join('\n\n');
	if (diff.length > MAX_DIFF_CHARS) {
		diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated; use the tools to read files.`;
	}

	const parts = [
		`<pull_request author="${input.pullRequest.author}">\n<title>${input.pullRequest.title}</title>\n<description>\n${input.pullRequest.body || '(none)'}\n</description>\n</pull_request>`
	];
	const guidelines = await loadRepoGuidelines(input.repoDir, input.trustedSource);
	if (guidelines) parts.push(`<repository_guidelines>\n${guidelines}\n</repository_guidelines>`);
	if (input.learnings.length) {
		parts.push(
			`<team_learnings>\n${input.learnings.map((l) => `- ${l}`).join('\n')}\n</team_learnings>`
		);
	}
	parts.push(`<diff>\n${diff}\n</diff>`);
	// The diff leaves lockfiles out. With a sandbox a question about a bump can be checked.
	const dependencies = input.sandbox ? dependencyChanges(parsed) : [];
	if (dependencies.length) {
		parts.push(
			`<dependency_changes>\nVersions the pull request's lockfiles change:\n${formatDependencyChanges(dependencies)}\n</dependency_changes>`
		);
	}
	const context = formatChatContext(replyContext);
	if (context) parts.push(context);
	if (input.focus) {
		parts.push(
			`<code_location path="${input.focus.path}"${input.focus.line ? ` line="${input.focus.line}"` : ''}>\n${input.focus.diffHunk ?? ''}\n</code_location>`
		);
	}
	parts.push(
		`<conversation>\n${input.thread
			.map(
				(m) =>
					`<message author="${m.author}"${m.fromBot ? ' bot="true"' : ''}>\n${m.body}\n</message>`
			)
			.join('\n')}\n</conversation>`
	);

	const result = await callModel('chat', input.model, input, () =>
		generateText({
			model: input.model.model,
			...reasoningCallOptions(input.model),
			instructions: [
				chatInstructions(
					input.language,
					!!input.onMarkFinding,
					{
						repository: input.repository,
						headSha: input.headSha
					},
					replyContext
				),
				...(input.sandbox ? [SANDBOX_GUIDANCE] : [])
			].join('\n\n'),
			prompt: parts.join('\n\n'),
			tools,
			stopWhen: isStepCount(20),
			abortSignal: input.signal
		})
	);

	return result.text.trim() || "Sorry, I couldn't come up with an answer to that.";
}
