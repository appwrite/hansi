/** Whether a GitHub comment author is this bot, e.g. `hansi-codes[bot]` for `@hansi-codes`. */
export function isBotAuthor(comment: { author: string; isBot: boolean }, mention: string): boolean {
	if (!comment.isBot) return false;
	const login = comment.author.replace(/\[bot\]$/i, '').toLowerCase();
	return login === mention.replace(/^@/, '').toLowerCase();
}

/**
 * Whether a review-thread reply without a mention is talking to the bot: the thread is one the
 * bot started (a finding), or the comment right before this one is the bot's answer.
 */
export function repliesToBot(
	thread: readonly { id: number; author: string; isBot: boolean }[],
	commentId: number,
	mention: string
): boolean {
	const root = thread[0];
	if (!root) return false;
	if (isBotAuthor(root, mention)) return true;
	const index = thread.findIndex((comment) => comment.id === commentId);
	const previous = index > 0 ? thread[index - 1] : undefined;
	return !!previous && isBotAuthor(previous, mention);
}
