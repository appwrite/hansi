import type { Log } from './context';
import { MARKER_NAMESPACE, SUMMARY_MARKER } from './format';
import type { ReviewEvent as TraceEvent } from './tools';

/**
 * Live progress for a running review. The check run and the summary comment say what Hansi is
 * doing while it works, instead of staying silent until the review is posted.
 *
 * Findings still arrive in one GitHub review at the end: the verify pass judges them together,
 * and the review carries the verdict, the inline-comment fallbacks, and the comment ids that
 * replies are traced by.
 */

export type ReviewPhase =
	| { kind: 'preparing' }
	| { kind: 'sandbox' }
	| { kind: 'reviewing'; files: number }
	| { kind: 'verifying'; findings: number }
	| { kind: 'publishing' };

/** What the status block at the top of the summary comment says. */
export type ReviewStatus =
	| { kind: 'running'; phase: ReviewPhase }
	| { kind: 'retrying' }
	| { kind: 'failed' }
	| { kind: 'skipped'; reason: string };

const STATUS_START = `<!-- ${MARKER_NAMESPACE}:status -->`;
const STATUS_END = `<!-- /${MARKER_NAMESPACE}:status -->`;
const STATUS_BLOCK = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}\n*`);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function phaseText(phase: ReviewPhase): string {
	switch (phase.kind) {
		case 'preparing':
			return 'Checking out the pull request';
		case 'sandbox':
			return 'Starting the sandbox';
		case 'reviewing':
			return phase.files ? `Reviewing ${plural(phase.files, 'file')}` : 'Reviewing the changes';
		case 'verifying':
			return `Verifying ${plural(phase.findings, 'possible finding')}`;
		case 'publishing':
			return 'Posting the review';
	}
}

/** The phase a trace event moves the review into, if any. */
export function phaseFromEvent(event: TraceEvent): ReviewPhase | null {
	if (event.type === 'files.prompt') {
		const shown = event.data?.shown;
		const notShown = event.data?.notShown;
		const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
		return { kind: 'reviewing', files: count(shown) + count(notShown) };
	}
	if (event.type === 'review.submitted') {
		const findings = Number(event.data?.findings ?? 0);
		return findings > 0 ? { kind: 'verifying', findings } : null;
	}
	return null;
}

/** The check run's title and summary while the review is in progress. */
export function checkRunProgress(phase: ReviewPhase): { title: string; summary: string } {
	return {
		title: phaseText(phase),
		summary: 'Hansi posts its findings and verdict when the review finishes.'
	};
}

/** The block at the top of the summary comment, between hidden markers so it can be replaced. */
export function statusBlock(
	status: ReviewStatus,
	input: { headSha: string; mention: string; previous: boolean; detailsUrl?: string }
): string {
	const sha = `\`${input.headSha.slice(0, 7)}\``;
	const lines: string[] = [];
	switch (status.kind) {
		case 'running':
			lines.push(`> ⏳ **Reviewing ${sha}** · ${phaseText(status.phase)}…`);
			break;
		case 'retrying':
			lines.push(`> ⚠️ **The review of ${sha} was interrupted.** Hansi will try again.`);
			break;
		case 'failed':
			lines.push(
				`> ⚠️ **Hansi could not finish reviewing ${sha}.** Comment <code>${input.mention} review</code> to try again.`
			);
			break;
		case 'skipped':
			lines.push(`> Skipped ${sha}: ${status.reason}`);
			break;
	}
	const notes = [
		input.previous && status.kind !== 'skipped'
			? 'The summary below is from the previous review.'
			: '',
		status.kind === 'running' && input.detailsUrl ? `[Follow along](${input.detailsUrl})` : ''
	].filter(Boolean);
	if (notes.length) lines.push('>', `> <sub>${notes.join(' · ')}</sub>`);
	return [STATUS_START, ...lines, STATUS_END].join('\n');
}

/** The status block in a summary body, if it has one. */
export function statusBlockOf(body: string): string | null {
	return STATUS_BLOCK.exec(body)?.[0].trimEnd() ?? null;
}

/** Removes the status block from a summary body. */
export function withoutStatusBlock(body: string): string {
	return body.replace(STATUS_BLOCK, '');
}

/** Whether a summary body (status block removed) holds a finished review's summary. */
export function hasReviewSummary(body: string | null): boolean {
	if (!body) return false;
	const rest = withoutStatusBlock(body).replace(SUMMARY_MARKER, '').trim();
	return rest.length > 0;
}

/**
 * Puts `block` at the top of a summary body, replacing any earlier status block. With no body,
 * the summary comment is the status block alone. A null block only removes the old one.
 */
export function withStatusBlock(body: string | null, block: string | null): string {
	const rest = body ? withoutStatusBlock(body) : SUMMARY_MARKER;
	if (!block) return rest;
	if (rest.startsWith(SUMMARY_MARKER)) {
		const after = rest.slice(SUMMARY_MARKER.length).replace(/^\n+/, '');
		return [SUMMARY_MARKER, block, after].filter(Boolean).join('\n\n');
	}
	return [SUMMARY_MARKER, block, rest].filter(Boolean).join('\n\n');
}

export interface ProgressTarget {
	headSha: string;
	mention: string;
	detailsUrl?: string;
	log: Log;
	updateCheckRun: (output: { title: string; summary: string }) => Promise<void>;
	readSummary: () => Promise<{ id: number; body: string } | null>;
	/** Edits the summary comment, or creates it when `id` is null. */
	writeSummary: (id: number | null, body: string) => Promise<void>;
}

export interface ReviewProgress {
	/** Moves to a phase. The summary shows the phases between `preparing` and `publishing`. */
	phase(phase: ReviewPhase): void;
	/** Follows the review's trace events. */
	onEvent(event: TraceEvent): void;
	/** Waits for pending writes and stops further updates, before the final summary is written. */
	close(): Promise<void>;
	/**
	 * Stops updates and leaves the summary with `status` (or none). A summary this run never
	 * touched is left alone unless an earlier attempt left a status block in it.
	 */
	settle(status: ReviewStatus | null): Promise<void>;
}

/**
 * Reports progress best-effort: GitHub writes are queued one at a time, off the review's path,
 * and a failed write is logged, never thrown.
 */
export function createReviewProgress(target: ProgressTarget): ReviewProgress {
	const { log } = target;
	let chain: Promise<void> = Promise.resolve();
	let closed = false;
	let touchedSummary = false;
	let lastPhase = '';

	const enqueue = (write: () => Promise<void>) => {
		chain = chain.then(write).catch((error) => {
			log.warn('could not update review progress', { err: error });
		});
	};

	/** `force` writes even when the summary has no status block (or does not exist yet). */
	const editSummary = async (status: ReviewStatus | null, force: boolean) => {
		const existing = await target.readSummary();
		if (!existing && (!status || !force)) return;
		if (!force && existing && !statusBlockOf(existing.body)) return;
		// A skip only needs saying where there is no earlier review to show instead.
		if (status?.kind === 'skipped' && hasReviewSummary(existing?.body ?? null)) status = null;
		const block = status
			? statusBlock(status, {
					headSha: target.headSha,
					mention: target.mention,
					previous: hasReviewSummary(existing?.body ?? null),
					detailsUrl: target.detailsUrl
				})
			: null;
		const body = withStatusBlock(existing?.body ?? null, block);
		if (existing?.body === body) return;
		await target.writeSummary(existing?.id ?? null, body);
	};

	const phase = (next: ReviewPhase) => {
		const text = phaseText(next);
		if (closed || text === lastPhase) return;
		lastPhase = text;
		enqueue(() => target.updateCheckRun(checkRunProgress(next)));
		if (next.kind === 'preparing' || next.kind === 'publishing') return;
		touchedSummary = true;
		enqueue(() => editSummary({ kind: 'running', phase: next }, true));
	};

	return {
		phase,
		onEvent(event) {
			const next = phaseFromEvent(event);
			if (next) phase(next);
		},
		async close() {
			closed = true;
			await chain;
		},
		async settle(status) {
			closed = true;
			await chain;
			await editSummary(status, touchedSummary).catch((error) =>
				log.warn('could not update the review status', { err: error })
			);
		}
	};
}
