/**
 * Text posted on GitHub when a job fails.
 *
 * The exception stays in the logs and, for a review, on the private review record. A pull request
 * comment or check run must not quote it: provider errors name vendors and can carry request
 * details.
 */

/** Posted once a chat job has used its attempts. */
export const CHAT_FAILURE_REPLY = "Sorry, I couldn't answer that right now.";

/** Check run body when a review throws. The title stays "Review failed". */
export const REVIEW_FAILURE_SUMMARY = 'The review did not finish.';

/**
 * The reply to post, or null while attempts remain. Built only from the attempt count, so the
 * error cannot be interpolated into it.
 */
export function chatFailureReply(job: { attempts: number; maxAttempts: number }): string | null {
	if (job.attempts < job.maxAttempts) return null;
	return CHAT_FAILURE_REPLY;
}
