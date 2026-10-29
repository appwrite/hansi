import { readFile } from 'node:fs/promises';
import {
	blockingSeverity,
	severityAtLeast,
	type ReasoningEffort,
	type RepoConfig,
	type Severity
} from './config';
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import {
	commentableLines,
	hunkIndexOf,
	parseGitHubPatch,
	parseUnifiedDiff,
	renderDiffExcerpt,
	renderFileDiff,
	type FileDiff
} from './diff';
import { runToSubmission } from './agent-loop';
import { dependencyChanges } from './dependencies';
import { filterFiles, isGeneratedOutput, isLockfile } from './filters';
import { cachedPrompt, callModel, type ModelCall, type ModelFailure } from './model-call';
import {
	compareSeverity,
	findingSchema,
	isDuplicateFinding,
	isUnattachedDrop,
	omittable,
	PLACEMENT_FAILURES,
	type DroppedFinding,
	type Finding,
	type PreviousFinding
} from './findings';
import {
	buildReviewPrompt,
	pullRequestSection,
	reviewerInstructions,
	reviewRules,
	subagentInstructions,
	verifierInstructions
} from './prompts';
import { presentReview } from './present';
import {
	createSandboxTools,
	SANDBOX_GUIDANCE,
	type CommandBudget,
	type CommandRunner
} from './sandbox';
import {
	createDelegateTool,
	MAX_SUBAGENT_STEPS,
	MAX_SUBAGENTS,
	SHARED_SANDBOX_GUIDANCE
} from './subagents';
import { tiers, type Tier } from './tier';
import { checkSuggestion } from './suggestions';
import { decideVerdict, openDefectApprovalReason, type Verdict } from './verdict';
import {
	createRepoTools,
	loadRepoGuidelines,
	resolveRepoPath,
	type EmitEvent,
	type TrustedSource
} from './tools';

export interface ReviewModel {
	model: LanguageModel;
	provider: string;
	modelId: string;
	/** Absent means the provider's default. */
	reasoningEffort?: ReasoningEffort | null;
}

export interface ReviewInput {
	/** Checkout of the PR head. */
	repoDir: string;
	/** Diff to review: the whole PR, or only the commits since the last review. */
	diff: string;
	/** Full PR diff (merge base → head); comments must land on it. Defaults to `diff`. */
	pullRequestDiff?: string;
	/** Set when `diff` only covers commits since this previously reviewed SHA. */
	incrementalFrom?: string;
	/** Findings already posted on this PR, so they are not repeated. */
	previousFindings?: PreviousFinding[];
	/**
	 * Posted findings not yet resolved or dismissed. The model checks whether the current code
	 * fixes them. Findings at the blocking severity, and bug-like findings at minor or above,
	 * keep a pull request from being approved.
	 */
	openFindings?: OpenFinding[];
	/** Team preferences from earlier conversations (see `remember` in chat). */
	learnings?: string[];
	/** Where to read repository guidelines from; defaults to the (untrusted) PR checkout. */
	trustedSource?: TrustedSource;
	/** When set, Hansi may not approve, for this reason (e.g. an outside contributor). */
	withholdApproval?: string;
	/**
	 * Summary and walkthrough from the last review. Incremental reviews update them so the
	 * summary keeps describing the whole pull request, not just the newest commits.
	 */
	previousSummary?: { summary: string; walkthrough: WalkthroughEntry[] };
	pullRequest: { title: string; body: string; author: string };
	/** Issues the pull request says it resolves: what the change is meant to do. */
	linkedIssues?: LinkedIssue[];
	/** Checks that already failed on the head commit, such as tests or type checks. */
	failedChecks?: FailedCheck[];
	config: RepoConfig;
	models: { review: ReviewModel; verify?: ReviewModel };
	onEvent?: EmitEvent;
	onModelCall?: (call: ModelCall) => void | Promise<void>;
	onModelError?: (failure: ModelFailure) => void | Promise<void>;
	signal?: AbortSignal;
	limits?: {
		maxDiffChars?: number;
		maxReviewSteps?: number;
		maxVerifySteps?: number;
		/** Subagents the reviewer may start with `delegate`; 0 turns delegation off. */
		maxSubagents?: number;
		maxSubagentSteps?: number;
	};
	/** Lets the review and verify passes run commands against the PR head. Off when absent. */
	sandbox?: CommandRunner;
}

export interface LinkedIssue {
	number: number;
	title: string;
	body: string;
}

export interface FailedCheck {
	name: string;
	conclusion: string;
	/** The check's own report, e.g. a test summary. */
	output: string;
	annotations: { path: string; line: number; message: string }[];
}

export interface WalkthroughEntry {
	path: string;
	change: string;
}

export interface OpenFinding {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	severity: Severity;
	/** As stored on the finding. Bug-like categories withhold approval even at minor. */
	category: string;
	title: string;
	body: string;
}

export type ReviewResult =
	| { status: 'skipped'; reason: string }
	| {
			status: 'completed';
			summary: string;
			reviewedFiles: string[];
			posted: Finding[];
			dropped: DroppedFinding[];
			/** Ids of open findings the current code fixes. */
			resolved: string[];
			/** Earlier blocking findings that are still unresolved. */
			stillOpenBlocking: number;
			verdict: Verdict;
			/** Merge confidence for the whole PR, S (best) to F. */
			tier: Tier;
			tierReason: string;
			/** What changed, per file, across the whole pull request. */
			walkthrough: WalkthroughEntry[];
			/** Incremental reviews: what the newest commits changed. */
			latestChanges: string | null;
			/** Why Hansi did not approve although it found nothing blocking. */
			approvalWithheld: string | null;
			/**
			 * Reviewable changed files that did not fit in the prompt, out of how many were
			 * considered. Null when every reviewable file was included.
			 */
			filesTooLargeForPrompt: { omitted: number; total: number } | null;
	  };

const submissionSchema = z.object({
	summary: z.string(),
	findings: z.array(findingSchema),
	resolved: z
		.array(z.string())
		.nullish()
		.transform((ids) => ids ?? [])
		.describe('Ids of <open_findings> that the current code fixes'),
	tier: omittable(z.enum(tiers)).describe('Merge confidence for the whole pull request'),
	walkthrough: z
		.array(z.object({ path: z.string(), change: z.string() }))
		.nullish()
		.transform((entries) => entries ?? [])
		.describe('One short line per changed file (or group of files) describing what changed'),
	latest_changes: omittable(z.string()).describe(
		'Incremental reviews only: one sentence on what the newest commits changed'
	),
	tier_reason: omittable(z.string()).describe('One sentence explaining the tier')
});
const verdictsSchema = z.object({
	verdicts: z.array(
		z.object({
			id: z.string(),
			keep: z.boolean(),
			reason: z.string(),
			suggestion_ok: omittable(z.boolean()).describe(
				'For findings with a suggestion: is applying it correct?'
			),
			start_line: omittable(z.number().int()).describe(
				'Only when the finding points at the wrong lines: the correct first line'
			),
			end_line: omittable(z.number().int()).describe(
				'Only when the finding points at the wrong lines: the correct last line'
			)
		})
	)
});

const DEFAULT_LIMITS = {
	maxDiffChars: 150_000,
	maxReviewSteps: 100,
	maxVerifySteps: 50,
	maxSubagents: MAX_SUBAGENTS,
	maxSubagentSteps: MAX_SUBAGENT_STEPS
};

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
	const limits = { ...DEFAULT_LIMITS, ...input.limits };
	const emit: EmitEvent = input.onEvent ?? (() => {});
	const { config } = input;

	const pullRequestFiles = input.pullRequestDiff ? parseUnifiedDiff(input.pullRequestDiff) : null;
	// After the base branch is merged into the pull request, the increment also carries the base
	// branch's changes. Comments can only land on files the pull request itself changes.
	const inPullRequest = (file: FileDiff) =>
		!pullRequestFiles || pullRequestFiles.some((f) => f.path === file.path);
	const changed = parseUnifiedDiff(input.diff);
	// Lockfiles, snapshots, and generated code are only checked by running something, so they
	// stay ignored without a sandbox.
	const { included, excluded } = filterFiles(
		changed.filter(inPullRequest),
		config.reviews.pathFilters,
		{ sandbox: !!input.sandbox }
	);
	for (const file of changed.filter((f) => !inPullRequest(f))) {
		excluded.push({ path: file.path, reason: 'not part of the pull request diff' });
	}
	emit({ type: 'files.filtered', data: { included: included.map((f) => f.path), excluded } });
	if (included.length === 0) {
		const reason = input.incrementalFrom
			? 'No new reviewable changes since the last review'
			: 'No reviewable changes';
		return { status: 'skipped', reason };
	}
	const previousFindings = input.previousFindings ?? [];

	// Keep the prompt within budget; files that don't fit are listed but not shown. Files checked
	// by running something go last so a large one cannot crowd out code. Lockfile versions are
	// listed separately.
	const shown: FileDiff[] = [];
	const notShown = [...excluded];
	let budget = limits.maxDiffChars;
	const lockfiles = included.filter((file) => isLockfile(file.path));
	const generated = included.filter((file) => isGeneratedOutput(file.path));
	const dependencies = dependencyChanges(lockfiles);
	const checked = new Set([...lockfiles, ...generated]);
	for (const file of [...included.filter((f) => !checked.has(f)), ...checked]) {
		const rendered = renderFileDiff(file);
		if (rendered.length > budget) {
			notShown.push({ path: file.path, reason: 'too large to show' });
			continue;
		}
		budget -= rendered.length;
		shown.push(file);
	}
	// With a sandbox the reviewer can still read the files and run the build and tests.
	if (shown.length === 0 && !input.sandbox) {
		return { status: 'skipped', reason: 'Diff too large to review' };
	}
	// `shown` is only the prompt. Placement uses `included`, so record which files the model
	// had to read with tools instead of seeing in the diff.
	const omittedFromPrompt = notShown.filter((file) => file.reason === 'too large to show');
	emit({
		type: 'files.prompt',
		data: {
			shown: shown.map((file) => file.path),
			notShown: omittedFromPrompt.map((file) => file.path)
		}
	});

	const pathInstructions = config.pathInstructions.flatMap((entry) => {
		const glob = new Bun.Glob(entry.path);
		return shown.some((file) => glob.match(file.path))
			? [`For files matching ${entry.path}: ${entry.instructions}`]
			: [];
	});

	// The reviewer, its subagents, and the verifier share the sandbox and its command budget.
	const commandBudget: CommandBudget = { used: 0 };
	const createTools = (emit: EmitEvent): ToolSet => ({
		...createRepoTools(input.repoDir, emit, {
			token: input.trustedSource?.token,
			baseRef: input.trustedSource?.ref
		}),
		...(input.sandbox ? createSandboxTools(input.sandbox, emit, commandBudget) : {})
	});
	const tools = createTools(emit);
	const guidelines = await loadRepoGuidelines(input.repoDir, input.trustedSource);
	const rules = reviewRules({
		guidelines,
		learnings: input.learnings,
		instructions: config.instructions,
		pathInstructions
	});
	const prompt = buildReviewPrompt({
		...input.pullRequest,
		linkedIssues: input.linkedIssues,
		failedChecks: input.failedChecks,
		guidelines,
		config,
		pathInstructions,
		diff: shown.map(renderFileDiff).join('\n\n'),
		excludedFiles: notShown,
		dependencyChanges: lockfiles.length ? dependencies : undefined,
		generatedFiles: generated.map((file) => file.path),
		incrementalFrom: input.incrementalFrom,
		learnings: input.learnings,
		previousFindings,
		openFindings: input.openFindings,
		previousSummary: input.incrementalFrom ? input.previousSummary : undefined,
		pullRequestFiles: input.incrementalFrom
			? (pullRequestFiles ?? []).map((f) => f.path)
			: undefined
	});

	// 1. Review: an agent loop that explores the repo, then submits findings. It may hand tasks
	//    to subagents that run in parallel; their findings join its own.
	const submitReview = tool({
		description: 'Submit the review. Call exactly once, at the end.',
		inputSchema: submissionSchema,
		execute: async () => 'Review submitted.'
	});
	const subagentFindings: Finding[] = [];
	const delegate =
		limits.maxSubagents > 0
			? createDelegateTool({
					model: input.models.review,
					instructions: withSharedSandbox(
						withSandboxGuidance(subagentInstructions(config), input),
						input
					),
					context: [pullRequestSection(input.pullRequest), ...rules],
					files: included,
					excluded,
					tools: createTools,
					emit,
					hooks: input,
					onFindings: (found) => void subagentFindings.push(...found),
					maxSubagents: limits.maxSubagents,
					maxSteps: limits.maxSubagentSteps
				})
			: undefined;
	const reviewerPrompt = reviewerInstructions(config, {
		subagents: delegate && limits.maxSubagents
	});
	const review = await callModel('review', input.models.review, input, () =>
		runToSubmission('submit_review', limits.maxReviewSteps, input.models.review, {
			instructions: delegate
				? withSharedSandbox(withSandboxGuidance(reviewerPrompt, input), input)
				: withSandboxGuidance(reviewerPrompt, input),
			prompt: cachedPrompt(input.models.review, prompt),
			tools: { ...tools, ...(delegate && { delegate }), submit_review: submitReview },
			abortSignal: input.signal
		})
	);
	const submission = review.toolCalls.findLast(
		(call) => call.toolName === 'submit_review' && !call.invalid
	);
	if (!submission) {
		throw new Error(
			'The review model did not submit a valid review. Check that it supports tool calling.'
		);
	}
	const submitted = submissionSchema.parse(submission.input);
	const { summary } = submitted;
	const findings = [...submitted.findings, ...subagentFindings];
	const openFindings = input.openFindings ?? [];
	const resolved = submitted.resolved.filter((id) => openFindings.some((f) => f.id === id));
	emit({
		type: 'review.submitted',
		data: {
			findings: findings.length,
			fromSubagents: subagentFindings.length,
			resolved,
			tier: submitted.tier ?? null
		}
	});

	// 2. Validate positions against every reviewable file, not only the ones that fit in the
	//    prompt. GitHub rejects comments outside the pull request diff. For incremental reviews
	//    the finding must be on a newly changed line and on a line of the full pull request diff.
	const dropped: DroppedFinding[] = [];
	const shownPaths = new Set(shown.map((file) => file.path));
	const place = (finding: Finding) => {
		const placed = placeFinding(finding, included);
		return placed && pullRequestFiles ? placeFinding(placed, pullRequestFiles) : placed;
	};
	const recordPlacement = (
		finding: Finding,
		outcome: { kept: boolean; code: string; reason: string }
	) => {
		emit({
			type: 'finding.placement',
			data: {
				path: finding.path,
				title: finding.title,
				startLine: finding.startLine,
				endLine: finding.endLine,
				kept: outcome.kept,
				code: outcome.code,
				reason: outcome.reason,
				shownInPrompt: shownPaths.has(finding.path)
			}
		});
	};
	const positioned = findings.flatMap((finding) => {
		const placed = place(finding);
		if (!placed) {
			const failure = placementFailure(finding, included, excluded, pullRequestFiles);
			dropped.push({ ...finding, dropReason: failure.reason });
			recordPlacement(finding, { kept: false, ...failure });
			return [];
		}
		// The file was past the prompt budget. Keep the finding; say so in the trace.
		if (!shownPaths.has(placed.path)) {
			recordPlacement(placed, {
				kept: true,
				code: 'not_shown',
				reason: 'File not shown in the prompt'
			});
		}
		if (isDuplicateFinding(placed, previousFindings)) {
			dropped.push({ ...placed, dropReason: 'Already reported in an earlier review' });
			return [];
		}
		return [placed];
	});

	// A few findings on the wrong line is normal. Most of them missing is the large-PR failure
	// mode where the posted review would otherwise hide what the model found.
	const unattached = dropped.filter((finding) => isUnattachedDrop(finding.dropReason));
	if (anchoringIsSuspicious(findings.length, unattached.length)) {
		emit({
			type: 'anchoring.suspicious',
			data: {
				submitted: findings.length,
				unattached: unattached.length,
				findings: unattached.map((finding) => ({
					path: finding.path,
					startLine: finding.startLine,
					endLine: finding.endLine,
					title: finding.title
				}))
			}
		});
	}

	// 3. Severity threshold from `.hansi.json`.
	const relevant = positioned.filter((finding) => {
		const keep = severityAtLeast(finding.severity, config.reviews.minSeverity);
		if (!keep)
			dropped.push({
				...finding,
				dropReason: `Below minSeverity (${config.reviews.minSeverity})`
			});
		return keep;
	});

	// 4. One comment per failure: the model sometimes reports the same bug twice. A different
	//    failure on the same lines stays.
	const distinct = dropDuplicates(relevant, dropped);

	// 5. Verify: a second, skeptical pass removes false positives. It can move findings, so
	//    two of them may now sit on the same lines: check for duplicates again.
	const verified = distinct.length
		? await verifyFindings(
				distinct,
				{ files: included, rules },
				input,
				tools,
				limits.maxVerifySteps,
				dropped,
				(finding) => {
					// A relocation must not land on something already reported.
					const placed = place(finding);
					return placed && !isDuplicateFinding(placed, previousFindings) ? placed : null;
				}
			).then((kept) => dropDuplicates(kept, dropped))
		: [];

	// 6. Cap the number of comments, most severe first.
	const capped = verified.slice(0, config.reviews.maxComments);

	// 7. A suggestion is applied verbatim with one click: never post one that breaks the code.
	const posted = await Promise.all(
		capped.map(async (finding) => {
			const check = await checkSuggestion(input.repoDir, finding);
			if (check.ok) return finding;
			emit({
				type: 'suggestion.removed',
				data: { path: finding.path, title: finding.title, reason: check.reason }
			});
			return withoutSuggestion(finding);
		})
	);
	for (const finding of verified.slice(config.reviews.maxComments)) {
		dropped.push({ ...finding, dropReason: `Over maxComments (${config.reviews.maxComments})` });
	}

	// 8. Verdict from findings that will be shown. The model wrote the summary and the grade in
	// the same call as its findings, before any of them were filtered or left unattached, so
	// reconcile both against what was actually posted or is still open. Placement misses stay in
	// `dropped` for that reconciliation; the summary comment lists them on their own.
	const stillOpen = openFindings.filter((f) => !resolved.includes(f.id));
	const threshold = blockingSeverity(config);
	const stillOpenBlocking = stillOpen.filter((f) => severityAtLeast(f.severity, threshold)).length;
	let verdict = decideVerdict({ posted, stillOpen, config });
	// Approval is the one outcome an attacker would want: only grant it when it is safe to.
	const truncated = shown.length < included.length;
	const approvalWithheld =
		verdict === 'approve'
			? (input.withholdApproval ??
				(truncated ? 'Part of the diff was too large to review, so Hansi did not approve.' : null))
			: openDefectApprovalReason([...posted, ...stillOpen], config);
	if (verdict === 'approve' && approvalWithheld) verdict = 'comment';
	const presented = presentReview({
		summary,
		modelTier: submitted.tier,
		modelTierReason: submitted.tier_reason,
		verdict,
		posted,
		stillOpen,
		dropped
	});

	emit({
		type: 'review.completed',
		data: {
			posted: posted.length,
			dropped: dropped.length,
			stillOpen: stillOpen.length,
			verdict,
			tier: presented.tier
		}
	});
	return {
		status: 'completed',
		summary: presented.summary,
		reviewedFiles: shown.map((f) => f.path),
		posted,
		dropped,
		resolved,
		stillOpenBlocking,
		verdict,
		tier: presented.tier,
		tierReason: presented.tierReason,
		walkthrough: mergeWalkthrough(
			submitted.walkthrough,
			input.incrementalFrom ? input.previousSummary?.walkthrough : undefined,
			pullRequestFiles?.map((f) => f.path)
		),
		latestChanges: input.incrementalFrom ? (submitted.latest_changes ?? null) : null,
		approvalWithheld,
		filesTooLargeForPrompt:
			shown.length < included.length
				? { omitted: included.length - shown.length, total: included.length }
				: null
	};
}

/**
 * At least half of the submitted findings, and at least two, could not be placed on a changed
 * line. One miss is ordinary; this is the signal that anchoring itself failed.
 */
export function anchoringIsSuspicious(submitted: number, unattached: number): boolean {
	return unattached >= 2 && unattached * 2 >= submitted;
}

/**
 * The walkthrough from this review, plus entries from the previous one for files the model did
 * not mention again but that are still part of the pull request.
 */
export function mergeWalkthrough(
	current: WalkthroughEntry[],
	previous: WalkthroughEntry[] = [],
	pullRequestPaths?: string[]
): WalkthroughEntry[] {
	const covered = new Set(current.map((entry) => entry.path));
	const carried = previous.filter(
		(entry) =>
			!covered.has(entry.path) && (!pullRequestPaths || pullRequestPaths.includes(entry.path))
	);
	return [...current, ...carried];
}

/** One finding per problem, most severe first; the other copies are dropped. */
function dropDuplicates(findings: Finding[], dropped: DroppedFinding[]): Finding[] {
	const distinct: Finding[] = [];
	for (const finding of [...findings].sort(compareSeverity)) {
		if (isDuplicateFinding(finding, distinct)) {
			dropped.push({ ...finding, dropReason: 'Duplicate of another finding in this review' });
		} else {
			distinct.push(finding);
		}
	}
	return distinct;
}

function withoutSuggestion(finding: Finding): Finding {
	const copy = { ...finding };
	delete copy.suggestion;
	return copy;
}

/**
 * Moves a kept finding to the lines the verifier says it is really about. The original position
 * already passed validation, so it stays when the corrected one is not commentable or would
 * repeat an earlier finding.
 */
function relocate(
	finding: Finding,
	verdict: { start_line?: number; end_line?: number },
	place: (finding: Finding) => Finding | null,
	emit?: EmitEvent
): Finding {
	const startLine = verdict.start_line ?? verdict.end_line;
	const endLine = verdict.end_line ?? verdict.start_line;
	if (startLine === undefined || endLine === undefined) return finding;
	if (startLine === finding.startLine && endLine === finding.endLine) return finding;
	const placed = place({ ...finding, startLine, endLine });
	if (!placed) return finding;
	emit?.({
		type: 'finding.relocated',
		data: {
			path: finding.path,
			title: finding.title,
			from: [finding.startLine, finding.endLine],
			to: [placed.startLine, placed.endLine]
		}
	});
	// A suggestion replaces exactly the lines it was written for.
	return withoutSuggestion(placed);
}

const PATH_FILTER_REASONS = new Set(['path filter', 'not in path filters', 'ignored by default']);

/**
 * Why a finding could not be anchored. The prompt only shows files that fit in the character
 * budget; that is not a reason to drop a finding whose lines are in the diff.
 */
function placementFailure(
	finding: Finding,
	included: FileDiff[],
	excluded: { path: string; reason: string }[],
	pullRequestFiles: FileDiff[] | null
): { reason: string; code: string } {
	const reviewFile = included.find((file) => file.path === finding.path);
	if (reviewFile) {
		const onReview = placeFinding(finding, included);
		if (onReview && pullRequestFiles && !placeFinding(onReview, pullRequestFiles)) {
			return { reason: PLACEMENT_FAILURES.outside_pr_diff, code: 'outside_pr_diff' };
		}
		return { reason: PLACEMENT_FAILURES.outside_hunk, code: 'outside_hunk' };
	}

	const skipped = excluded.find((file) => file.path === finding.path);
	if (skipped?.reason === 'not part of the pull request diff') {
		return { reason: PLACEMENT_FAILURES.not_in_diff, code: 'not_in_diff' };
	}
	if (skipped && PATH_FILTER_REASONS.has(skipped.reason)) {
		return { reason: PLACEMENT_FAILURES.path_filtered, code: 'path_filtered' };
	}
	if (skipped)
		return { reason: PLACEMENT_FAILURES.no_commentable_lines, code: 'no_commentable_lines' };
	return { reason: PLACEMENT_FAILURES.not_in_diff, code: 'not_in_diff' };
}

/** Clamps a finding onto commentable lines of a single hunk, or returns null. */
export function placeFinding(finding: Finding, files: FileDiff[]): Finding | null {
	const file = files.find((f) => f.path === finding.path);
	if (!file) return null;
	const lines = commentableLines(file);
	const endLine = Math.max(finding.startLine, finding.endLine);
	if (!lines.has(endLine)) return null;

	const startLine =
		lines.has(finding.startLine) &&
		hunkIndexOf(file, finding.startLine) === hunkIndexOf(file, endLine)
			? Math.min(finding.startLine, endLine)
			: endLine;
	return { ...finding, startLine, endLine };
}

/**
 * Places each finding on GitHub's own diff of the pull request, from its files API. Null for a
 * finding GitHub would reject inline: its file has no diff there (GitHub stops rendering diffs
 * on large pull requests) or its lines fall outside GitHub's hunks.
 */
export function placeOnGitHubDiff(
	findings: Finding[],
	files: { path: string; patch?: string }[]
): (Finding | null)[] {
	const diffs = files.flatMap((file) => {
		const parsed = file.patch ? parseGitHubPatch(file.path, file.patch) : null;
		return parsed ? [{ ...parsed, path: file.path }] : [];
	});
	return findings.map((finding) => placeFinding(finding, diffs));
}

async function verifyFindings(
	findings: Finding[],
	{ files, rules }: { files: FileDiff[]; rules: string[] },
	input: ReviewInput,
	tools: ToolSet,
	maxSteps: number,
	dropped: DroppedFinding[],
	place: (finding: Finding) => Finding | null
): Promise<Finding[]> {
	const verifyModel = input.models.verify ?? input.models.review;
	const listing = await Promise.all(
		findings.map(async (finding, i) => {
			const context = await codeContext(
				input.repoDir,
				finding.path,
				finding.startLine,
				finding.endLine
			);
			const file = files.find((f) => f.path === finding.path);
			const excerpt = file && renderDiffExcerpt(file, finding.startLine, finding.endLine);
			const change = excerpt ? `\n\n<diff>\n${excerpt}\n</diff>` : '';
			const suggestion =
				finding.suggestion === undefined
					? ''
					: `\n\n<suggestion replaces_lines="${finding.startLine}-${finding.endLine}">\n${finding.suggestion}\n</suggestion>`;
			return `<finding id="F${i + 1}" path="${finding.path}" lines="${finding.startLine}-${finding.endLine}" severity="${finding.severity}">\n${finding.title}\n\n${finding.body}\n\n<code>\n${context}\n</code>${change}${suggestion}\n</finding>`;
		})
	);

	const submitVerdicts = tool({
		description: 'Submit a verdict for every finding. Call exactly once.',
		inputSchema: verdictsSchema,
		execute: async () => 'Verdicts submitted.'
	});

	const result = await callModel('verify', verifyModel, input, () =>
		runToSubmission('submit_verdicts', maxSteps, verifyModel, {
			instructions: withSandboxGuidance(verifierInstructions(input.config.reviews.profile), input),
			prompt: cachedPrompt(
				verifyModel,
				[`Pull request: ${input.pullRequest.title}`, ...rules, ...listing].join('\n\n')
			),
			tools: { ...tools, submit_verdicts: submitVerdicts },
			abortSignal: input.signal
		})
	);

	const call = result.toolCalls.findLast((c) => c.toolName === 'submit_verdicts' && !c.invalid);
	const verdicts = call ? verdictsSchema.parse(call.input).verdicts : [];
	const byId = new Map(verdicts.map((v) => [v.id, v]));
	input.onEvent?.({ type: 'verify.completed', data: { verdicts } });

	// A finding without a verdict is kept: a flaky verifier must not silently hide real bugs.
	return findings.flatMap((original, i) => {
		const verdict = byId.get(`F${i + 1}`);
		if (verdict && !verdict.keep) {
			dropped.push({ ...original, dropReason: `Verifier: ${verdict.reason}` });
			return [];
		}
		const finding = verdict ? relocate(original, verdict, place, input.onEvent) : original;
		if (verdict?.suggestion_ok === false && finding.suggestion !== undefined) {
			input.onEvent?.({
				type: 'suggestion.removed',
				data: { path: finding.path, title: finding.title, reason: 'verifier rejected it' }
			});
			return [withoutSuggestion(finding)];
		}
		return [finding];
	});
}

function withSandboxGuidance(instructions: string, input: ReviewInput): string {
	return input.sandbox ? `${instructions}\n\n${SANDBOX_GUIDANCE}` : instructions;
}

function withSharedSandbox(instructions: string, input: ReviewInput): string {
	return input.sandbox ? `${instructions}\n${SHARED_SANDBOX_GUIDANCE}` : instructions;
}

async function codeContext(repoDir: string, path: string, start: number, end: number) {
	try {
		const lines = (await readFile(resolveRepoPath(repoDir, path), 'utf8')).split('\n');
		const from = Math.max(start - 10, 1);
		const to = Math.min(end + 10, lines.length);
		return lines
			.slice(from - 1, to)
			.map((line, i) => `${String(from + i).padStart(5)}  ${line}`)
			.join('\n');
	} catch {
		return '(file unavailable)';
	}
}
