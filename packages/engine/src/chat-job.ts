import { blockingSeverity, parseRepoConfig, REPO_CONFIG_FILE } from './config';
import { runChat, type ThreadMessage } from './chat';
import {
	chatFinding,
	chatReplyFields,
	findingsNamedIn,
	openBodyFindings,
	type ChatFindingRow
} from './chat-finding';
import { repliesToBot } from './chat-reply';
import type { Attempt, EngineContext } from './context';
import { absolutizeLinks } from './format';
import { checkoutPullRequest } from './git';
import type { ChatJob } from './jobs';
import { chatFailureReply } from './public-failure';
import type { ChatRef, ModelUsage, PullRef } from './results';
import { lazySandbox, openSandbox } from './review-sandbox';
import { modelUsage, withWorkdir } from './shared';
import { refreshSummaryAfterSettlement } from './summary';

// One answer to a comment on a pull request. It follows hansi.codes' worker step for step;
// Appwrite's Reviews API stands in for hansi.codes' database.

export async function runChatJob(
	job: ChatJob,
	context: EngineContext,
	attempt: Attempt,
	signal?: AbortSignal
): Promise<void> {
	const { results, log } = context;
	const { comment } = job;
	const pull: PullRef = {
		projectId: job.repository.projectId,
		repositoryId: job.repository.repositoryId,
		pullNumber: job.pullNumber
	};

	// Findings GitHub would not take inline have no thread; a conversation comment answers them.
	const findings = await results.listFindings(pull, { limit: 200 });
	const bodyFindings = comment.kind === 'issue' ? openBodyFindings(findings) : [];
	if (job.unmentioned && comment.kind === 'issue' && bodyFindings.length === 0) {
		log.info('conversation comment without a mention and no open body findings, skipping');
		return;
	}

	const connection = await context.github.forRepository(job.repository);
	const { github, app } = connection;
	const mention = `@${app.slug}`;

	const threadOf = () =>
		comment.kind === 'review'
			? github.getReviewThread(job.pullNumber, comment.rootCommentId ?? comment.id)
			: github.getRecentIssueComments(job.pullNumber);
	// A reply without a mention is answered only when it replies to Hansi. Checked before the 👀,
	// so people talking among themselves in a review thread see nothing from Hansi.
	const early = job.unmentioned || bodyFindings.length > 0 ? await threadOf() : undefined;
	if (early && comment.kind === 'review' && !repliesToBot(early, comment.id, mention)) {
		log.info('review-thread reply is not to Hansi, skipping');
		return;
	}
	// The comment being answered can settle a body-listed finding by quoting its title or line.
	const answered = early?.find((c) => c.id === comment.id)?.body ?? '';
	const named = findingsNamedIn(answered, bodyFindings, { mentioned: !job.unmentioned });
	if (job.unmentioned && comment.kind === 'issue' && named.length === 0) {
		log.info('conversation comment does not name an open finding, skipping');
		return;
	}

	if (attempt.attempts === 1) {
		await github
			.acknowledgeComment({ id: comment.id, kind: comment.kind })
			.catch((error: unknown) => log.warn('could not react to comment', { err: error }));
	}

	const repository = `${job.repository.owner}/${job.repository.name}`;
	const files = { headSha: '' };
	const reply = async (body: string) => {
		const text = files.headSha ? absolutizeLinks(body, repository, files.headSha) : body;
		if (comment.kind === 'review') {
			await github.replyToReviewComment(job.pullNumber, comment.rootCommentId ?? comment.id, text);
		} else {
			await github.createIssueComment(job.pullNumber, text);
		}
	};

	const usage: ModelUsage[] = [];
	const chat: ChatRef = { ...pull, commentId: comment.id };
	try {
		const pr = await github.getPullRequest(job.pullNumber);
		files.headSha = pr.headSha;
		// Settings and guidelines come from the base branch, which the PR author cannot change.
		const { config } = parseRepoConfig(await github.getFileContent(REPO_CONFIG_FILE, pr.baseSha));

		const comments = early ?? (await threadOf());
		const thread: ThreadMessage[] = comments.map((c) => ({
			author: c.author,
			body: c.body,
			fromBot: c.isBot
		}));
		const root = comments[0];
		const bodyFinding = named[0];
		const focus =
			comment.kind === 'review' && root?.path
				? { path: root.path, line: root.line ?? undefined, diffHunk: root.diffHunk }
				: bodyFinding
					? { path: bodyFinding.path, line: bodyFinding.endLine }
					: undefined;

		// Replies on a finding Hansi posted can resolve or dismiss that finding.
		const finding: ChatFindingRow | undefined =
			chatFinding(findings, comment.rootCommentId) ?? bodyFinding;
		const findingIds = finding ? (named.length ? named.map((f) => f.id) : [finding.id]) : [];

		let settled = false;
		const learnings = await results.listLearnings(job.repository);

		const token = await github.getInstallationToken();
		const { sandboxes } = context;
		const answer = await withWorkdir(context.workdir, async (repoDir) => {
			const diff = await checkoutPullRequest({
				dir: repoDir,
				cloneUrl: pr.cloneUrl,
				token,
				pullNumber: pr.number,
				baseSha: pr.baseSha,
				headSha: pr.headSha
			});
			// Most replies need no commands, so the sandbox starts only when the first one runs.
			const sandbox = sandboxes
				? lazySandbox(async () =>
						openSandbox({
							client: sandboxes,
							archiveUrl: await github.getArchiveUrl(pr.headSha),
							config,
							emit: () => {},
							log
						})
					)
				: undefined;
			return runChat({
				repoDir,
				repository,
				headSha: pr.headSha,
				pullRequest: pr,
				diff,
				thread,
				focus,
				learnings,
				trustedSource: { ref: pr.baseSha, token },
				language: config.language,
				...chatReplyFields(comment, finding),
				model: context.models.review,
				onModelCall: (call) => {
					usage.push(modelUsage(call));
				},
				signal,
				onRemember: async (rule) => {
					await results.createLearning(job.repository, {
						body: rule,
						author: comment.author,
						sourceUrl: comment.url
					});
				},
				onMarkFinding: finding
					? async (status, reason) => {
							await results.updateFindings(pull, findingIds, { status, reason });
							settled = true;
						}
					: undefined,
				sandbox: sandbox?.runner
			}).finally(() => sandbox?.close());
		});

		await reply(answer);
		// A finding settled in the conversation (fixed, or intended) closes its thread after the answer.
		if (settled) {
			if (comment.rootCommentId) {
				await github
					.resolveReviewThreads(job.pullNumber, [comment.rootCommentId])
					.catch((error: unknown) => log.warn('could not resolve thread', { err: error }));
			}
			// Keep the PR summary's open-finding list and tier in sync with the dismissal.
			await refreshSummaryAfterSettlement({
				results,
				connection,
				pull,
				repository,
				consoleUrl: job.repository.consoleUrl,
				blockingSeverity: blockingSeverity(config),
				log
			}).catch((error: unknown) =>
				log.warn('could not refresh summary after settlement', { err: error })
			);
		}
		log.info('chat reply posted');
	} catch (error) {
		// Tell the person the answer failed, once retries are exhausted. The reply is fixed:
		// the error can name a provider or include request details, and it stays in the logs.
		const notice = chatFailureReply(attempt);
		if (notice) await reply(notice).catch(() => {});
		throw error;
	} finally {
		if (usage.length) {
			await results
				.recordChatUsage(chat, usage)
				.catch((error: unknown) => log.warn('could not record chat usage', { err: error }));
		}
	}
}
