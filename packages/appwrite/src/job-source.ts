import {
	JetStreamApiCodes,
	JetStreamApiError,
	jetstream,
	type Consumer,
	type ConsumerConfig,
	type JetStreamClient,
	type JsMsg
} from '@nats-io/jetstream';
import { connect, headers, type NatsConnection } from '@nats-io/transport-node';
import type { JobSource, Lease } from '@hansi/engine';
import { xxhash128 } from 'hash-wasm';
import { parseJob } from './payload';
import {
	CONTENT_TYPE,
	decodeEnvelope,
	queueNames,
	SPARE_DELIVERY_METADATA,
	WORK_CONSUMER,
	WORK_SEQUENCE,
	WORK_TIME
} from './queue';

// Jobs from the Appwrite reviews queue on NATS JetStream, read the way utopia-php/queue's
// Broker\Nats reads them, so that Appwrite's queue tooling (retry, reap, sizes) works on this
// queue like on any other. The queue is Appwrite's: this service takes up the streams and the
// work consumer Appwrite's publisher provisioned and never changes their configuration.

export interface QueueConfig {
	/** `nats://user:pass@host:4222`, as in `_APP_CONNECTIONS_QUEUE`. Query parameters are the publisher's. */
	url: string;
	/** The queue's name, e.g. `v1-reviews`. */
	name: string;
}

export interface JobSourceOptions {
	/** A message no worker can use, which went to the dead stream instead of a handler. */
	onDiscard?: (reason: string, details: Record<string, unknown>) => void;
	/** How long one pull waits for a message before it looks at the signal again. At least a second. */
	pollMs?: number;
}

/** The work consumer's settings, which its owner chose. */
interface Settings {
	ackWaitMs: number;
	/** Deliveries this service may use. Infinity for a consumer without a limit. */
	maxDeliver: number;
	/** The delivery past `maxDeliver` the owner allows for one whose every attempt died. */
	spare: number | null;
	backoffMs: number[] | null;
}

const NANOS_PER_MS = 1_000_000;

function settingsOf(config: ConsumerConfig): Settings {
	const allowed = config.max_deliver ?? -1;
	const spare = config.metadata?.[SPARE_DELIVERY_METADATA] !== undefined && allowed >= 1;
	return {
		ackWaitMs: (config.ack_wait ?? 30_000 * NANOS_PER_MS) / NANOS_PER_MS,
		maxDeliver: allowed < 1 ? Infinity : spare ? allowed - 1 : allowed,
		spare: spare ? allowed : null,
		backoffMs: config.backoff?.length ? config.backoff.map((n) => n / NANOS_PER_MS) : null
	};
}

class Connection {
	private constructor(
		readonly nc: NatsConnection,
		readonly js: JetStreamClient,
		readonly consumer: Consumer,
		public settings: Settings,
		readonly names: ReturnType<typeof queueNames>
	) {}

	static async open(config: QueueConfig): Promise<Connection> {
		const url = new URL(config.url);
		if (url.protocol !== 'nats:') throw new Error(`Not a NATS queue: ${url.protocol}//`);
		const nc = await connect({
			servers: `${url.hostname}:${url.port || '4222'}`,
			user: url.username ? decodeURIComponent(url.username) : undefined,
			pass: url.password ? decodeURIComponent(url.password) : undefined,
			name: 'hansi',
			maxReconnectAttempts: -1
		});
		try {
			const names = queueNames(config.name);
			const js = jetstream(nc);
			const consumer = await js.consumers.get(names.workStream, WORK_CONSUMER).catch((error) => {
				const missing: number[] = [
					JetStreamApiCodes.ConsumerNotFound,
					JetStreamApiCodes.StreamNotFound
				];
				if (error instanceof JetStreamApiError && missing.includes(error.code)) {
					throw new Error(
						`Queue ${config.name} is not provisioned on NATS: Appwrite creates it on its first publish`,
						{ cause: error }
					);
				}
				throw error;
			});
			return new Connection(
				nc,
				js,
				consumer,
				settingsOf((await consumer.info(true)).config),
				names
			);
		} catch (error) {
			await nc.close();
			throw error;
		}
	}

	/** The consumer is shared and its owner may have changed it since it was read. */
	async refresh(): Promise<Settings> {
		this.settings = settingsOf((await this.consumer.info()).config);
		return this.settings;
	}

	/** The dead stream copy of a message the broker can re-drive, at the subject the broker uses. */
	async deadLetter(msg: JsMsg, pid: string): Promise<void> {
		const id = `${pid}.dead.${msg.info.streamSequence}`;
		const keyed = new Uint8Array([...new TextEncoder().encode(`${id}\n`), ...msg.data]);
		const subject = `${this.names.deadSubject}.${await xxhash128(keyed)}`;
		const meta = headers();
		meta.set(WORK_SEQUENCE, String(msg.info.streamSequence));
		meta.set(WORK_TIME, String(msg.info.timestampNanos));
		try {
			// Stored once per subject, so a second copy of the same delivery is refused.
			await this.js.publish(subject, msg.data, {
				headers: meta,
				msgID: id,
				expect: { lastSubjectSequence: 0 }
			});
		} catch (error) {
			const copied =
				error instanceof JetStreamApiError &&
				error.code === JetStreamApiCodes.StreamWrongLastSequence;
			if (!copied) throw error;
		}
	}

	/** Set aside a message no handler should see, unread, the way the broker parks one. */
	async park(msg: JsMsg, reason: string): Promise<void> {
		const meta = headers();
		const contentType = msg.headers?.get(CONTENT_TYPE);
		if (contentType) meta.set(CONTENT_TYPE, contentType);
		await this.js.publish(this.names.deadSubject, msg.data, { headers: meta });
		msg.term(reason);
	}

	/** The broker's backoff for a delivery: 1-based, the last entry repeats. */
	backoffFor(deliveryCount: number): number | undefined {
		const backoff = this.settings.backoffMs;
		if (!backoff) return undefined;
		return backoff[Math.min(Math.max(deliveryCount, 1), backoff.length) - 1];
	}
}

export class AppwriteJobSource implements JobSource {
	private connection: Promise<Connection> | null = null;

	constructor(
		readonly config: QueueConfig,
		readonly options: JobSourceOptions = {}
	) {}

	private open(): Promise<Connection> {
		this.connection ??= Connection.open(this.config).catch((error: unknown) => {
			this.connection = null;
			throw error;
		});
		return this.connection;
	}

	async next(signal: AbortSignal): Promise<Lease | null> {
		while (!signal.aborted) {
			const connection = await this.open();
			// The client refuses a pull that expires in under a second.
			const expires = Math.max(1_000, this.options.pollMs ?? 5_000);
			const msg = await connection.consumer.next({ expires });
			if (!msg) continue;
			const lease = await this.lease(connection, msg);
			if (lease) return lease;
		}
		return null;
	}

	/** Stops reading and lets acknowledgements in flight reach the server. */
	async close(): Promise<void> {
		const connection = await this.connection?.catch(() => null);
		this.connection = null;
		await connection?.nc.drain();
	}

	private async lease(connection: Connection, msg: JsMsg): Promise<Lease | null> {
		const delivery = msg.info.deliveryCount;
		const details = { queue: this.config.name, sequence: msg.info.streamSequence, delivery };

		// Every delivery before this one died unacknowledged. The owner allows this one so the
		// message is dead-lettered here rather than left where nothing delivers it.
		let { spare } = connection.settings;
		if (spare !== null && delivery >= spare) {
			spare = (await connection.refresh().catch(() => connection.settings)).spare;
			if (spare !== null && delivery >= spare) {
				await connection.park(msg, 'max deliveries exceeded');
				this.options.onDiscard?.('max deliveries exceeded', details);
				return null;
			}
		}

		const envelope = decodeEnvelope(msg.data, msg.headers?.get(CONTENT_TYPE) || undefined);
		if (!envelope) {
			await connection.park(msg, 'payload could not be decoded');
			this.options.onDiscard?.('payload could not be decoded', details);
			return null;
		}

		let job;
		try {
			job = parseJob(envelope.payload);
		} catch (error) {
			// Every delivery would fail the same way: it goes where the broker puts permanent failures.
			await connection.deadLetter(msg, envelope.pid);
			msg.term('permanent failure');
			this.options.onDiscard?.('invalid job', { ...details, pid: envelope.pid, err: error });
			return null;
		}

		// A review outlasts the ack wait, so the delivery is kept alive until it is settled.
		const keepalive = setInterval(
			() => msg.working(),
			Math.max(100, connection.settings.ackWaitMs / 3)
		);
		let settled = false;
		const settle = async (settlement: () => Promise<void>) => {
			if (settled) return;
			settled = true;
			clearInterval(keepalive);
			await settlement();
		};

		const { maxDeliver } = connection.settings;
		return {
			job,
			attempts: delivery - 1,
			maxAttempts: maxDeliver,
			ack: () =>
				settle(async () => {
					if (!(await msg.ackAck())) throw new Error('The queue did not confirm the ack');
				}),
			nack: ({ retry }) =>
				settle(async () => {
					if (retry && delivery < maxDeliver) {
						msg.nak(connection.backoffFor(delivery));
					} else {
						await connection.deadLetter(msg, envelope.pid);
						msg.term(retry ? 'max deliveries exceeded' : 'permanent failure');
					}
					await connection.nc.flush();
				})
		};
	}
}
