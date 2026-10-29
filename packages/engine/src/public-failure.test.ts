import { expect, test } from 'bun:test';
import { chatFailureReply, REVIEW_FAILURE_SUMMARY } from './public-failure';

/** The text Hansi posted on appwrite/appwrite#13982. */
const providerError = new Error(
	'Failed after 3 attempts. Last error: AI_APICallError: Bedrock is unable to process your request.'
);

test('a failed chat posts a fixed reply and only after the last attempt', () => {
	expect(chatFailureReply({ attempts: 1, maxAttempts: 2 })).toBeNull();

	const reply = chatFailureReply({ attempts: 2, maxAttempts: 2 });
	expect(reply).toBe("Sorry, I couldn't answer that right now.");
	expect(reply ?? '').not.toContain(providerError.message);
	expect(reply ?? '').not.toContain('Bedrock');
	expect(reply ?? '').not.toContain('AI_APICallError');
});

test('a failed review check does not quote the provider error', () => {
	expect(REVIEW_FAILURE_SUMMARY).toBe('The review did not finish.');
	expect(REVIEW_FAILURE_SUMMARY).not.toContain(providerError.message);
	expect(REVIEW_FAILURE_SUMMARY).not.toContain('Bedrock');
});
