import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	checkoutPullRequest,
	git,
	gitDiff,
	modelUsage,
	openSandbox,
	parseRepoConfig,
	REPO_CONFIG_FILE,
	runReview,
	type Log,
	type ModelCall,
	type ModelUsage,
	type ReviewInput,
	type ReviewModel,
	type ReviewSandbox,
	type SandboxClient,
	type TraceStep
} from '@hansi/engine';
import { cloneUrl, isGitHubUrl, type EvalCase } from './case';
import { scoreReview, type CaseScore, type Judge } from './score';

/** What one review of a case runs with. */
export interface RunSettings {
	models: { review: ReviewModel; verify?: ReviewModel };
	subagents: boolean;
	/** Where the agents run commands. Without one, the review only reads the code. */
	sandboxes?: SandboxClient;
	judge?: Judge;
	tolerance?: number;
	/** Token for private repositories on github.com; never sent to another host. */
	token?: string;
	log: Log;
	signal?: AbortSignal;
}

/** A checkout of a case: the pull request head, with the case's patch applied. */
export interface Checkout {
	dir: string;
	diff: string;
	/** `.hansi.json` from the base commit, or null when it has none. */
	baseConfig: string | null;
	close(): Promise<void>;
}

const EVAL_AUTHOR = ['-c', 'user.name=hansi-eval', '-c', 'user.email=eval@hansi.invalid'];

/**
 * Checks out a case's head the way a review does (a blobless clone, the diff against the merge
 * base), then applies its patch as one more commit, so the diff and the files agree.
 */
export async function checkoutCase(
	evalCase: EvalCase,
	options: { token?: string; signal?: AbortSignal } = {}
): Promise<Checkout> {
	const dir = await mkdtemp(join(tmpdir(), `hansi-eval-${evalCase.id}-`));
	const close = () => rm(dir, { recursive: true, force: true });
	try {
		const { signal } = options;
		const url = cloneUrl(evalCase.repo);
		const token = isGitHubUrl(url) ? options.token : undefined;
		let diff = await checkoutPullRequest({
			dir,
			cloneUrl: url,
			token,
			pullNumber: evalCase.pull ?? 0,
			baseSha: evalCase.base,
			headSha: evalCase.head,
			// Without a pull request, fetch the head commit itself.
			headRef: evalCase.pull ? undefined : evalCase.head,
			signal
		});
		if (evalCase.patch) {
			await git(['apply', '--index', evalCase.patch], { cwd: dir, token, signal });
			await git([...EVAL_AUTHOR, 'commit', '--quiet', '--no-verify', '-m', 'eval: inject'], {
				cwd: dir,
				signal
			});
			diff = await gitDiff(
				['diff', '--no-color', '--no-ext-diff', '--find-renames', `${evalCase.base}...HEAD`],
				{ cwd: dir, token, signal }
			);
		}
		const baseConfig = await git(['show', `${evalCase.base}:${REPO_CONFIG_FILE}`], {
			cwd: dir,
			token,
			signal
		}).catch(() => null);
		return { dir, diff, baseConfig, close };
	} catch (error) {
		await close();
		throw error;
	}
}

export type CaseRun =
	| {
			case: string;
			run: number;
			status: 'completed';
			score: CaseScore;
			tier: string;
			durationMs: number;
			usage: ModelUsage[];
			/** Commands the agents ran in the sandbox. */
			commands: number;
	  }
	| { case: string; run: number; status: 'skipped'; reason: string; durationMs: number }
	| { case: string; run: number; status: 'failed'; error: string; durationMs: number };

/** Reviews a checked-out case once and scores the review. */
export async function reviewCase(
	evalCase: EvalCase,
	checkout: Checkout,
	settings: RunSettings,
	run = 1
): Promise<CaseRun> {
	const started = performance.now();
	const elapsed = () => Math.round(performance.now() - started);
	const usage: ModelUsage[] = [];
	let commands = 0;
	const emit = (event: TraceStep) => {
		if (event.type === 'tool.run_command' && !event.data?.skipped) commands++;
	};

	const config = parseRepoConfig(
		evalCase.config ? JSON.stringify(evalCase.config) : checkout.baseConfig
	).config;

	let sandbox: ReviewSandbox | undefined;
	try {
		if (settings.sandboxes) {
			sandbox = await openSandbox({
				client: settings.sandboxes,
				repoDir: checkout.dir,
				config,
				emit,
				log: settings.log
			});
		}
		const input: ReviewInput = {
			repoDir: checkout.dir,
			diff: checkout.diff,
			trustedSource: {
				ref: evalCase.base,
				token: isGitHubUrl(cloneUrl(evalCase.repo)) ? settings.token : undefined
			},
			pullRequest: evalCase.pullRequest,
			linkedIssues: evalCase.linkedIssues,
			config,
			models: settings.models,
			onEvent: emit,
			onModelCall: (call: ModelCall) => void usage.push(modelUsage(call)),
			signal: settings.signal,
			sandbox: sandbox?.runner,
			limits: settings.subagents ? undefined : { maxSubagents: 0 }
		};
		const result = await runReview(input);
		if (result.status === 'skipped') {
			return {
				case: evalCase.id,
				run,
				status: 'skipped',
				reason: result.reason,
				durationMs: elapsed()
			};
		}
		const score = await scoreReview({
			expected: evalCase.expected.findings,
			expectedVerdict: evalCase.expected.verdict,
			posted: result.posted,
			dropped: result.dropped,
			verdict: result.verdict,
			tolerance: settings.tolerance,
			judge: settings.judge
		});
		return {
			case: evalCase.id,
			run,
			status: 'completed',
			score,
			tier: result.tier,
			durationMs: elapsed(),
			usage,
			commands
		};
	} catch (error) {
		return {
			case: evalCase.id,
			run,
			status: 'failed',
			error: (error as Error).message,
			durationMs: elapsed()
		};
	} finally {
		await sandbox?.close();
	}
}
