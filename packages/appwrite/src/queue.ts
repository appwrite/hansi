// The wire contract of an Appwrite queue on NATS JetStream, as utopia-php/queue's Broker\Nats
// writes it. Appwrite publishes reviews through that broker, so these names and shapes have to
// match it exactly: a different stream or subject is a different queue.

/** Stream and subject names for a queue, e.g. `Q_V1-REVIEWS` and `q.v1-reviews.normal`. */
export function queueNames(name: string) {
	const token = name.replace(/[^A-Za-z0-9_-]/g, '_');
	const subject = `q.${token.toLowerCase()}`;
	const stream = `Q_${token.toUpperCase()}`;
	return {
		workStream: stream,
		deadStream: `${stream}_DEAD`,
		workSubject: `${subject}.normal`,
		deadSubject: `${subject}.dead`
	};
}

/** The durable pull consumer every worker of a queue shares. */
export const WORK_CONSUMER = 'worker';

/** Marks a work consumer that allows one delivery past the broker's own attempts. */
export const SPARE_DELIVERY_METADATA = 'utopia_queue_spare_delivery';

export const CONTENT_TYPE = 'Content-Type';
export const JSON_CONTENT_TYPE = 'application/json';
/** On a dead letter: the work stream message it was copied from, to delete on a re-drive. */
export const WORK_SEQUENCE = 'Utopia-Queue-Work-Sequence';
export const WORK_TIME = 'Utopia-Queue-Work-Time';

/** What the broker wraps every payload in. */
export interface Envelope {
	pid: string;
	queue: string;
	payload: unknown;
}

/**
 * The envelope in a message, or null when this service cannot read it. The broker names its
 * codec in a Content-Type header; a message without one predates the header and is JSON.
 */
export function decodeEnvelope(data: Uint8Array, contentType: string | undefined): Envelope | null {
	if (contentType !== undefined && contentType !== JSON_CONTENT_TYPE) return null;
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(data));
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	// The broker's own check: the three keys are there.
	const { pid, queue, timestamp, payload } = value as Record<string, unknown>;
	if (pid == null || queue == null || timestamp == null) return null;
	return { pid: String(pid), queue: String(queue), payload };
}
