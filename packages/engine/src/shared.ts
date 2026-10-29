import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Log } from './context';
import type { GitHubConnection } from './github';
import type { ModelCall } from './model-call';
import type { ModelUsage, ReviewRecord } from './results';

// What the review and chat jobs share: the work directory, links into the Console, the bot's
// change requests, and model usage.

/** The latest completed review of a pull request, by when it finished. */
export function lastCompleted(reviews: readonly ReviewRecord[]): ReviewRecord | undefined {
	return reviews
		.filter((review) => review.status === 'completed')
		.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
}

/** The Console's page for one review. Without a Console root, the link is left out. */
export function reviewDetailsUrl(
	consoleUrl: string | undefined,
	projectId: string,
	reviewId: string
): string | undefined {
	if (!consoleUrl) return undefined;
	const base = consoleUrl.replace(/\/+$/, '');
	return `${base}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}`;
}

/** One model call as Appwrite meters it. */
export function modelUsage(call: ModelCall): ModelUsage {
	return {
		role: call.role,
		provider: call.provider,
		model: call.modelId,
		inputTokens: call.usage.inputTokens ?? 0,
		outputTokens: call.usage.outputTokens ?? 0,
		cachedInputTokens: call.usage.inputTokenDetails?.cacheReadTokens ?? 0,
		reasoningTokens: call.usage.outputTokenDetails?.reasoningTokens ?? 0,
		durationMs: call.durationMs
	};
}

/**
 * Withdraws the bot's own "changes requested" reviews on a pull request. A failure is logged, not
 * thrown: the review or reply it follows has already been posted.
 */
export async function withdrawChangeRequests(
	{ github, app }: GitHubConnection,
	pullNumber: number,
	message: string,
	log: Log
): Promise<number> {
	try {
		return await github.dismissChangeRequests(pullNumber, {
			botLogin: `${app.slug}[bot]`,
			message
		});
	} catch (error) {
		log.warn('could not dismiss earlier change request', { err: error });
		return 0;
	}
}

const workdirRoot = (root?: string) => root ?? join(tmpdir(), 'hansi');
/**
 * Job directories carry the container's hostname, so containers sharing a work directory each
 * clean up only their own. A container keeps its hostname across restarts.
 */
const jobPrefix = (instance: string) => `job-${instance}-`;
/** No job runs this long, so another container's directory this old was left behind. */
const STALE_MS = 6 * 60 * 60_000;

/** Runs `fn` with a fresh temporary directory that is always removed afterwards. */
export async function withWorkdir<T>(
	root: string | undefined,
	fn: (dir: string) => Promise<T>
): Promise<T> {
	const base = workdirRoot(root);
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, jobPrefix(hostname())));
	try {
		return await fn(dir);
	} finally {
		await removeTree(dir);
	}
}

/**
 * Removes the checkouts that jobs left behind when the service stopped mid-job (a restart, a
 * deploy, an out-of-memory kill): all of this container's, and other containers' once they are
 * stale. With `ownJobs: false` it only removes stale ones, which is safe while jobs run.
 */
export async function clearWorkdir(
	root: string | undefined,
	options: { ownJobs?: boolean; instance?: string; now?: number } = {}
): Promise<void> {
	const { ownJobs = true, instance = hostname(), now = Date.now() } = options;
	const base = workdirRoot(root);
	const entries = await readdir(base).catch(() => []);
	await Promise.all(
		entries
			.filter((name) => name.startsWith('job-'))
			// Best effort: one directory that cannot be removed must not stop the service.
			.map(async (name) => {
				const path = join(base, name);
				const own = ownJobs && name.startsWith(jobPrefix(instance));
				const remove = own || now - (await lstat(path)).mtimeMs > STALE_MS;
				if (remove) await removeTree(path);
			})
			.map((removal) => removal.catch(() => {}))
	);
}

/** Removes a directory tree, including read-only directories git can leave behind. */
export async function removeTree(dir: string): Promise<void> {
	await Bun.spawn(['chmod', '-R', 'u+w', dir], { stdout: 'ignore', stderr: 'ignore' }).exited;
	await rm(dir, { recursive: true, force: true });
}
