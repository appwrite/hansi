import { MARKER_NAMESPACE, SUMMARY_MARKER } from './format';
import type { GitHubClient, GitHubConnection } from './github';

// Several Appwrite projects can review the same repository, each through its own `repositories`
// row and the same GitHub App, so their reviews of one pull request share a bot account. Nothing
// hansi.codes writes to GitHub says which review it belongs to: each project would edit the
// other's summary comment, take over its check run and dismiss its change requests. This scope
// keys those writes by the repository row, and keeps the engine itself as hansi.codes has it.
//
// Review threads need no key: findings, and so the threads Hansi resolves, live in each project's
// own database.

/** The summary comment of one `repositories` row. Hansi's legacy summary marker is not in it. */
export function summaryMarkerFor(repositoryId: string): string {
	return `<!-- ${MARKER_NAMESPACE}:summary:${repositoryId} -->`;
}

const REVIEW_MARKER_PREFIX = `<!-- ${MARKER_NAMESPACE}:review:`;

/** Hidden in the body of every review a `repositories` row submits. */
export function reviewMarkerFor(repositoryId: string): string {
	return `${REVIEW_MARKER_PREFIX}${repositoryId} -->`;
}

/**
 * Whether a review of the bot's belongs to this repository row: it carries the row's marker, or
 * no row's, when it was submitted before reviews were keyed and only one project could review.
 */
export function isOwnReview(body: string, repositoryId: string): boolean {
	return body.includes(reviewMarkerFor(repositoryId)) || !body.includes(REVIEW_MARKER_PREFIX);
}

/**
 * Whether a summary written before markers were keyed may be taken over by this project. Its
 * Console links name the project that wrote it; one naming another project is left to that one.
 * Without links (no Console URL) the first project to review takes it over.
 */
export function isOwnLegacySummary(body: string, projectId: string): boolean {
	return (
		body.includes(`/projects/${encodeURIComponent(projectId)}/reviews/`) ||
		!body.includes('/projects/')
	);
}

/**
 * The connection as one `repositories` row sees it. The engine keeps reading and writing the
 * legacy summary marker; here it becomes the row's own. A summary comment written before markers
 * were keyed is taken over by the project that wrote it (see `isOwnLegacySummary`).
 */
export function scopeToRepository(
	connection: GitHubConnection,
	repository: { projectId: string; repositoryId: string }
): GitHubConnection {
	const { github } = connection;
	const { projectId, repositoryId } = repository;
	const marker = summaryMarkerFor(repositoryId);
	const toRow = (body: string) => body.replace(SUMMARY_MARKER, marker);
	const toEngine = (body: string) => body.replace(marker, SUMMARY_MARKER);

	const summary = async (issueNumber: number) => {
		const own = await github.getMarkedComment(issueNumber, marker);
		if (own) return { ...own, body: toEngine(own.body) };
		const legacy = await github.getMarkedComment(issueNumber, SUMMARY_MARKER);
		return legacy && isOwnLegacySummary(legacy.body, projectId) ? legacy : null;
	};

	const overrides = {
		async getMarkedComment(issueNumber: number, wanted: string) {
			if (wanted !== SUMMARY_MARKER) return github.getMarkedComment(issueNumber, wanted);
			return summary(issueNumber);
		},
		async upsertMarkedComment(issueNumber: number, wanted: string, body: string) {
			if (wanted !== SUMMARY_MARKER) return github.upsertMarkedComment(issueNumber, wanted, body);
			const existing = await summary(issueNumber);
			if (!existing) return github.upsertMarkedComment(issueNumber, marker, toRow(body));
			await github.updateIssueComment(existing.id, toRow(body));
			return { id: existing.id, url: existing.url };
		},
		updateIssueComment(commentId: number, body: string) {
			return github.updateIssueComment(commentId, toRow(body));
		},
		createIssueComment(issueNumber: number, body: string) {
			return github.createIssueComment(issueNumber, toRow(body));
		},
		createReview(input: Parameters<GitHubClient['createReview']>[0]) {
			const body = [input.body, reviewMarkerFor(repositoryId)].filter(Boolean).join('\n\n');
			return github.createReview({ ...input, body });
		},
		dismissChangeRequests(
			pullNumber: number,
			input: Parameters<GitHubClient['dismissChangeRequests']>[1]
		) {
			return github.dismissChangeRequests(pullNumber, {
				...input,
				only: (body) => isOwnReview(body, repositoryId) && (!input.only || input.only(body))
			});
		},
		startCheckRun(input: Parameters<GitHubClient['startCheckRun']>[0]) {
			return github.startCheckRun({ ...input, externalId: repositoryId });
		}
	} satisfies Partial<GitHubClient>;
	// Everything else goes to the client itself, bound to it.
	const scoped = new Proxy(github, {
		get(target, property) {
			if (Object.hasOwn(overrides, property)) {
				return overrides[property as keyof typeof overrides];
			}
			const value: unknown = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { ...connection, github: scoped };
}
