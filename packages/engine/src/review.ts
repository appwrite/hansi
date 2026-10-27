import { readFile } from 'node:fs/promises';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { runToSubmission } from './agent';
import type { RepoConfig } from './config';
import { renderExcerpt, renderFileDiff, type FileDiff } from './diff';
import { filterFiles } from './filters';
import {
	dedupe,
	findingSchema,
	isDuplicate,
	optional,
	placeFinding,
	type Dropped,
	type Located,
	type ReviewFinding
} from './findings';
import {
	bySeverity,
	isAtLeast,
	tiers,
	type Category,
	type Severity,
	type Tier,
	type Verdict
} from './grading';
import {
	attribute,
	pullRequestSection,
	reviewerInstructions,
	reviewPrompt,
	rulesSections,
	untrusted,
	verifierInstructions
} from './prompts';
import type { ModelUsage } from './results';
import { finalTier, standing } from './tier';
import { createCommandTools, type SandboxSession } from './commands';
import { createRepoTools, loadGuidelines, resolveRepoPath, type Emit } from './tools';
import { decideVerdict } from './verdict';

// One review of one pull request head: the reviewer reads the diff and reports findings, code
// places them on lines GitHub accepts, a verifier checks each against the code, and code decides
// the verdict and caps the tier. Posting to GitHub and storing results happen outside.

/** Diff characters the reviewer's prompt holds. Files past it are listed, and read with tools. */
export const DIFF_BUDGET = 150_000;
export const REVIEW_STEPS = 40;
export const VERIFY_STEPS = 25;

/** A finding from an earlier review, not resolved yet. */
export interface OpenFinding extends Located {
	id: string;
	severity: Severity;
	category: Category;
	body: string;
}

export interface ReviewInput {
	/** Checkout of the pull request head. The base commit must be in its object store. */
	repoDir: string;
	baseSha: string;
	/** Installation token, for objects a partial clone has to download. */
	token?: string;
	pullRequest: { title: string; body: string; author: string };
	files: FileDiff[];
	config: RepoConfig;
	openFindings: OpenFinding[];
	/** Findings earlier reviews posted, open or not, so they are not reported again. */
	alreadyReported: Located[];
	/** The author can push to the repository. */
	trustedAuthor: boolean;
}

export interface ReviewOptions {
	reviewer: LanguageModel;
	/** Defaults to the reviewer. */
	verifier?: LanguageModel;
	/** Commands in a sandbox, for both agents. Without it they only read. */
	sandbox?: SandboxSession;
	emit?: Emit;
	usage?: (usage: ModelUsage) => void;
	signal?: AbortSignal;
}

export interface ReviewResult {
	summary: string;
	walkthrough: { path: string; summary: string }[];
	/** To post, worst first. */
	findings: ReviewFinding[];
	dropped: Dropped[];
	/** Ids of open findings the reviewer saw fixed. */
	resolved: string[];
	tier: Tier;
	tierReason: string;
	verdict: Verdict;
	/** Some changed files did not fit the prompt. */
	partial: boolean;
	notShown: { path: string; reason: string }[];
}

const reviewSubmission = z.object({
	summary: z.string(),
	walkthrough: z.array(z.object({ path: z.string(), summary: z.string() })).default([]),
	findings: z.array(findingSchema).default([]),
	resolved: optional(z.array(z.string())),
	tier: z.enum(tiers),
	tier_reason: optional(z.string())
});

const verdictSubmission = z.object({
	verdicts: z.array(
		z.object({
			id: z.string(),
			keep: z.boolean(),
			reason: z.string(),
			suggestion_ok: optional(z.boolean()),
			start_line: optional(z.number().int().positive()),
			end_line: optional(z.number().int().positive())
		})
	)
});

/** Splits the reviewed files into those whose diff fits the budget and those listed instead. */
export function fitDiff(
	files: FileDiff[],
	budget = DIFF_BUDGET
): { diff: string; shown: FileDiff[]; over: FileDiff[] } {
	const shown: FileDiff[] = [];
	const over: FileDiff[] = [];
	const parts: string[] = [];
	let used = 0;
	for (const file of files) {
		const rendered = renderFileDiff(file);
		if (used + rendered.length > budget) {
			over.push(file);
			continue;
		}
		used += rendered.length;
		shown.push(file);
		parts.push(rendered);
	}
	return { diff: parts.join('\n\n'), shown, over };
}

export async function runReview(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
	const { config, repoDir } = input;
	const emit: Emit = options.emit ?? (() => {});

	const { included, excluded } = filterFiles(input.files, config.reviews.paths);
	const { diff, over } = fitDiff(included);
	const notShown = [
		...excluded,
		...over.map((file) => ({ path: file.path, reason: 'too large for this review' }))
	];
	// Changed files skipped by the default filters (lockfiles, generated code, build output) or
	// over the budget went unread, so they cannot count as reviewed.
	const partial = over.length > 0 || excluded.some((file) => file.reason === 'ignored');
	const pathInstructions = config.pathInstructions
		.filter((rule) => {
			const glob = new Bun.Glob(rule.path);
			return included.some((file) => glob.match(file.path));
		})
		.map((rule) => `${rule.path}: ${rule.instructions}`);
	const guidelines = await loadGuidelines(repoDir, input.baseSha, input.token);
	const tools = {
		...createRepoTools(repoDir, { emit, baseSha: input.baseSha, token: input.token }),
		...(options.sandbox ? createCommandTools(options.sandbox) : {})
	};
	emit('review.start', { files: included.length, notShown: notShown.length, partial });

	const submission = await runToSubmission({
		role: 'review',
		model: options.reviewer,
		instructions: reviewerInstructions(config, !!options.sandbox),
		prompt: reviewPrompt({
			pullRequest: input.pullRequest,
			config,
			guidelines,
			pathInstructions,
			diff,
			notShown,
			alreadyReported: input.alreadyReported,
			openFindings: input.openFindings
		}),
		tools,
		submit: {
			name: 'submit_review',
			description: 'Submit the review. Call it exactly once, at the end.',
			schema: reviewSubmission
		},
		maxSteps: REVIEW_STEPS,
		emit,
		usage: options.usage,
		signal: options.signal
	});
	if (!submission) throw new Error('The reviewer did not submit a review');
	emit('review.submitted', { findings: submission.findings.length, tier: submission.tier });

	const dropped: Dropped[] = [];
	const earlier = [...input.alreadyReported, ...input.openFindings];
	const candidates: ReviewFinding[] = [];
	for (const finding of submission.findings) {
		const placed = placeFinding(finding, included);
		if (!placed) dropped.push({ ...finding, reason: 'Not on a changed line' });
		else if (!isAtLeast(placed.severity, config.reviews.minSeverity)) {
			dropped.push({ ...placed, reason: 'Below the minimum severity' });
		} else if (isDuplicate(placed, earlier)) {
			dropped.push({ ...placed, reason: 'Reported in an earlier review' });
		} else candidates.push(placed);
	}

	const verified = await verify(dedupe(candidates, dropped), input, included, {
		guidelines,
		pathInstructions,
		...options,
		emit
	});
	const confirmed = verified.kept.sort(bySeverity);
	dropped.push(...verified.dropped);
	// The comment limit only limits what is posted: findings over it still grade the pull request.
	const kept = confirmed.slice(0, config.reviews.maxComments);
	for (const finding of confirmed.slice(config.reviews.maxComments)) {
		dropped.push({ ...finding, reason: 'Over the comment limit' });
	}

	const openIds = new Set(input.openFindings.map((f) => f.id));
	const resolved = [...new Set(submission.resolved ?? [])].filter((id) => openIds.has(id));
	const stillOpen = input.openFindings.filter((f) => !resolved.includes(f.id));
	const graded = [...confirmed, ...stillOpen];
	const tier = finalTier(
		submission.tier,
		graded.map((f) => f.severity)
	);
	const tierReason =
		tier === submission.tier ? (submission.tier_reason ?? '') : standing(graded).reason;
	const verdict = decideVerdict({
		posted: confirmed,
		open: stillOpen,
		config,
		trustedAuthor: input.trustedAuthor,
		partial
	});
	emit('review.done', { findings: kept.length, dropped: dropped.length, tier, verdict });

	return {
		summary: submission.summary,
		walkthrough: submission.walkthrough,
		findings: kept,
		dropped,
		resolved,
		tier,
		tierReason,
		verdict,
		partial,
		notShown
	};
}

/** Numbered lines of the head version around a finding, so the verifier starts from the code. */
async function currentCode(repoDir: string, finding: ReviewFinding, context = 10): Promise<string> {
	try {
		const lines = (await readFile(resolveRepoPath(repoDir, finding.path), 'utf8')).split('\n');
		const first = Math.max(finding.startLine - context, 1);
		const last = Math.min(finding.endLine + context, lines.length);
		return lines
			.slice(first - 1, last)
			.map((line, i) => `${String(first + i).padStart(5)}  ${line}`)
			.join('\n');
	} catch {
		return '(could not be read)';
	}
}

async function verify(
	findings: ReviewFinding[],
	input: ReviewInput,
	files: FileDiff[],
	options: ReviewOptions & {
		emit: Emit;
		guidelines: { path: string; content: string }[];
		pathInstructions: string[];
	}
): Promise<{ kept: ReviewFinding[]; dropped: Dropped[] }> {
	if (!findings.length) return { kept: [], dropped: [] };
	const { emit } = options;

	const blocks = await Promise.all(
		findings.map(async (finding, index) => {
			const file = files.find((f) => f.path === finding.path);
			const excerpt = file ? renderExcerpt(file, finding.startLine, finding.endLine) : null;
			return [
				`<finding id="f${index + 1}" path="${attribute(finding.path)}" lines="${finding.startLine}-${finding.endLine}" severity="${finding.severity}" category="${finding.category}">`,
				`<title>${untrusted(finding.title)}</title>`,
				`<body>\n${untrusted(finding.body)}\n</body>`,
				`<code>\n${untrusted(await currentCode(input.repoDir, finding))}\n</code>`,
				...(excerpt ? [`<diff>\n${untrusted(excerpt)}\n</diff>`] : []),
				...(finding.suggestion
					? [`<suggestion>\n${untrusted(finding.suggestion)}\n</suggestion>`]
					: []),
				'</finding>'
			].join('\n');
		})
	);
	const prompt = [
		pullRequestSection(input.pullRequest),
		...rulesSections({
			config: input.config,
			guidelines: options.guidelines,
			pathInstructions: options.pathInstructions
		}),
		`<findings>\n${blocks.join('\n\n')}\n</findings>`
	].join('\n\n');

	const submission = await runToSubmission({
		role: 'verify',
		model: options.verifier ?? options.reviewer,
		instructions: verifierInstructions(input.config.reviews.profile, !!options.sandbox),
		prompt,
		tools: {
			...createRepoTools(input.repoDir, { emit, baseSha: input.baseSha, token: input.token }),
			...(options.sandbox ? createCommandTools(options.sandbox) : {})
		},
		submit: {
			name: 'submit_verdicts',
			description: 'Submit a verdict for every finding. Call it exactly once, at the end.',
			schema: verdictSubmission
		},
		maxSteps: VERIFY_STEPS,
		emit,
		usage: options.usage,
		signal: options.signal
	});
	if (!submission) {
		// Posting unchecked findings beats losing real bugs to a verifier that failed to answer.
		emit('verify.skipped', { findings: findings.length });
		return { kept: findings, dropped: [] };
	}

	const verdicts = new Map(submission.verdicts.map((v) => [v.id, v]));
	const kept: ReviewFinding[] = [];
	const dropped: Dropped[] = [];
	findings.forEach((finding, index) => {
		const verdict = verdicts.get(`f${index + 1}`);
		// A finding the verifier skipped stays, for the same reason as above.
		if (!verdict) return void kept.push(finding);
		if (!verdict.keep) return void dropped.push({ ...finding, reason: verdict.reason });

		let result = finding;
		if (verdict.start_line !== undefined || verdict.end_line !== undefined) {
			const moved = placeFinding(
				{
					...finding,
					startLine: verdict.start_line ?? verdict.end_line ?? finding.startLine,
					endLine: verdict.end_line ?? verdict.start_line ?? finding.endLine
				},
				files
			);
			// A relocation onto lines GitHub refuses keeps the reviewer's placement.
			if (moved) result = moved;
		}
		// The suggestion was written for the old lines, so a moved finding loses it too.
		const sameLines = result.startLine === finding.startLine && result.endLine === finding.endLine;
		if (result.suggestion && (verdict.suggestion_ok !== true || !sameLines)) {
			result = { ...result, suggestion: undefined };
		}
		kept.push(result);
	});
	emit('verify.done', { kept: kept.length, dropped: dropped.length });
	return { kept, dropped };
}
