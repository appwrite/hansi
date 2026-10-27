import { describe, expect, test } from 'bun:test';
import { decodeEnvelope, queueNames } from './queue';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('queueNames', () => {
	// The names Broker\Nats gives these queues. A different name is a different queue.
	test('names streams and subjects as the broker does', () => {
		expect(queueNames('v1-reviews')).toEqual({
			workStream: 'Q_V1-REVIEWS',
			deadStream: 'Q_V1-REVIEWS_DEAD',
			workSubject: 'q.v1-reviews.normal',
			deadSubject: 'q.v1-reviews.dead'
		});
	});

	test('folds dots and other characters into one token', () => {
		expect(queueNames('a.b c')).toMatchObject({
			workStream: 'Q_A_B_C',
			workSubject: 'q.a_b_c.normal'
		});
	});
});

describe('decodeEnvelope', () => {
	const envelope = { pid: 'p1', queue: 'v1-reviews', timestamp: 1, payload: { type: 'review' } };

	test('reads a JSON envelope', () => {
		expect(decodeEnvelope(bytes(envelope), 'application/json')).toEqual({
			pid: 'p1',
			queue: 'v1-reviews',
			payload: { type: 'review' }
		});
	});

	test('reads a message from before the Content-Type header', () => {
		expect(decodeEnvelope(bytes(envelope), undefined)?.pid).toBe('p1');
	});

	test('refuses a codec it cannot read', () => {
		expect(decodeEnvelope(bytes(envelope), 'application/vnd.php.igbinary')).toBeNull();
	});

	test('refuses a message that is not an envelope', () => {
		expect(decodeEnvelope(new TextEncoder().encode('{'), undefined)).toBeNull();
		expect(decodeEnvelope(bytes({ payload: {} }), undefined)).toBeNull();
		expect(decodeEnvelope(bytes([1]), undefined)).toBeNull();
	});
});
