import { RedisClient } from 'bun';
import type { JobSource, Lease } from '@hansi/engine';
import { parseJob } from './payload';
import type { JobSourceOptions, QueueConfig } from './job-source';

// Jobs from the Appwrite reviews queue on Redis, read the way utopia-php/queue's Broker\Redis
// reads them. Self-hosted Appwrite publishes every queue there. The scripts in `./redis` are
// that broker's own (MIT), copied unchanged, so a message moves through the same lists and keys
// as on any Appwrite worker and `queue-retry` re-drives this queue's failures like any other's.

const NAMESPACE = 'utopia-queue';
/** Heartbeat lifetime, in seconds. A running job refreshes it every third of this. */
const CLAIM_TTL = 90;
/** Seconds between sweeps for claims no worker holds any more, across every worker. */
const REAP_INTERVAL = 60;
const REAP_LIMIT = 1_000;
/** Seconds since publication before a claim without a heartbeat counts as stale. */
const REAP_AFTER = 90_000;

/** Deliveries a job gets. The broker has no limit of its own; this is the service's. */
export const REDIS_MAX_ATTEMPTS = 3;
/** Wait before a failed job goes back on the queue, by the attempts it had. */
const RETRY_DELAY_MS = [10_000, 60_000, 300_000];

export interface RedisJobSourceOptions extends JobSourceOptions {
	/** How long a job waits before it is retried. For tests. */
	retryDelayMs?: (attempts: number) => number;
}

type Script =
	'reserve' | 'claim' | 'settle' | 'extend' | 'expired' | 'recover' | 'reclaim' | 'abandon';

interface Envelope {
	pid: string;
	queue: string;
	timestamp: number;
	payload: unknown;
	attempts: number;
}

/** The envelope Broker\Redis writes, or null for bytes it would set aside as poison. */
function decode(raw: string): Envelope | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const { pid, queue, timestamp, payload, attempts } = value as Record<string, unknown>;
	if (pid == null || queue == null || timestamp == null) return null;
	return {
		pid: String(pid),
		queue: String(queue),
		timestamp: Number(timestamp),
		payload,
		attempts: Number(attempts ?? 0) || 0
	};
}

function token(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
}

export class RedisJobSource implements JobSource {
	/** Blocking pops and claims. One at a time: a blocked pop holds the connection. */
	private readonly receive: RedisClient;
	/** Settlements, heartbeats and sweeps. */
	private readonly commands: RedisClient;
	private readonly scripts = new Map<Script, { body: string; sha: string }>();
	private receiving: Promise<unknown> = Promise.resolve();
	private lastSweep = 0;
	private readonly closing = new AbortController();
	/** The worker's shutdown signal, from the last `next`. */
	private shutdown: AbortSignal | null = null;

	constructor(
		readonly config: QueueConfig,
		readonly options: RedisJobSourceOptions = {}
	) {
		const url = new URL(config.url);
		if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
			throw new Error(`Not a Redis queue: ${url.protocol}//`);
		}
		this.receive = new RedisClient(config.url);
		this.commands = new RedisClient(config.url);
	}

	private key(kind: string, suffix?: string): string {
		const key = `${NAMESPACE}.${kind}.${this.config.name}`;
		return suffix === undefined ? key : `${key}.${suffix}`;
	}

	private async script(
		client: RedisClient,
		name: Script,
		keys: string[],
		args: (string | number)[]
	): Promise<unknown> {
		let script = this.scripts.get(name);
		if (!script) {
			const body = await Bun.file(new URL(`./redis/${name}.lua`, import.meta.url)).text();
			script = { body, sha: new Bun.CryptoHasher('sha1').update(body).digest('hex') };
			this.scripts.set(name, script);
		}
		const command = [String(keys.length), ...keys, ...args.map(String)];
		try {
			return await client.send('EVALSHA', [script.sha, ...command]);
		} catch (error) {
			// Not loaded on this server yet, or no more: it did not run.
			if (!String(error).includes('NOSCRIPT')) throw error;
			return client.send('EVAL', [script.body, ...command]);
		}
	}

	async next(signal: AbortSignal): Promise<Lease | null> {
		this.shutdown = signal;
		while (!signal.aborted && !this.closing.signal.aborted) {
			await this.sweep();
			const claimed = await this.serialized(() => this.reserve());
			if (!claimed) continue;
			if (signal.aborted) {
				// Arrived after shutdown began: it goes back for another worker.
				await this.settle(claimed, 'release');
				return null;
			}
			const lease = await this.lease(claimed);
			if (lease) return lease;
		}
		return null;
	}

	/** Stops reading. Call it once every lease is settled. */
	async close(): Promise<void> {
		this.closing.abort();
		await this.receiving.catch(() => {});
		this.receive.close();
		this.commands.close();
	}

	/** Aborts on shutdown: a job waiting to be retried goes back on the queue at once. */
	private stopping(): AbortSignal {
		const signals = [this.closing.signal];
		if (this.shutdown) signals.push(this.shutdown);
		return AbortSignal.any(signals);
	}

	private serialized<T>(run: () => Promise<T>): Promise<T> {
		const result = this.receiving.catch(() => {}).then(run);
		this.receiving = result;
		return result;
	}

	/** Moves one message from the queue to this worker's claims, as Broker\Redis::receive. */
	private async reserve(): Promise<Claimed | null> {
		if (this.closing.signal.aborted) return null;
		const timeout = Math.max(1, Math.round((this.options.pollMs ?? 5_000) / 1_000));
		const receipt = token();
		const reservation = this.key('reservations', receipt);
		const keys = [
			this.key('queue'),
			this.key('reservations'),
			reservation,
			this.key('processing'),
			this.key('stats', 'total'),
			this.key('stats', 'processing')
		];
		let batch = (await this.script(this.receive, 'reserve', keys, [1, CLAIM_TTL, timeout, 0])) as
			string[] | null;
		if (!batch?.length) {
			// The script registered the reservation before this blocks, so a crash after the
			// move is recovered by the sweep.
			const raw = await this.receive.send('BRPOPLPUSH', [
				this.key('queue'),
				reservation,
				String(timeout)
			]);
			batch = typeof raw === 'string' ? [raw] : [];
		}
		const raw = batch[0];
		if (raw === undefined) return null;

		const envelope = decode(raw);
		const claimKeys = [
			this.key('reservations'),
			reservation,
			this.key('processing'),
			this.key('stats', 'total'),
			this.key('stats', 'processing'),
			this.key('poison')
		];
		if (!envelope) {
			await this.script(this.receive, 'claim', claimKeys, [CLAIM_TTL, receipt, 0, raw]);
			this.options.onDiscard?.('payload could not be decoded', { queue: this.config.name });
			return null;
		}
		const { pid } = envelope;
		await this.script(
			this.receive,
			'claim',
			[...claimKeys, this.key('jobs', pid), this.key('claims', pid), this.key('owners', pid)],
			[CLAIM_TTL, receipt, 1, raw, pid]
		);
		return { envelope, receipt };
	}

	/** Commits, rejects or releases a claim, as Broker\Redis::settle. */
	private async settle(
		{ envelope, receipt }: Claimed,
		operation: 'commit' | 'reject' | 'release'
	): Promise<void> {
		const { pid } = envelope;
		const outcome = operation === 'commit' ? 'success' : 'failed';
		const list = operation === 'release' ? 'queue' : 'failed';
		const [result] = (await this.script(
			this.commands,
			'settle',
			[
				this.key('claims', pid),
				this.key('jobs', pid),
				this.key('processing'),
				this.key('stats', 'processing'),
				this.key('stats', outcome),
				this.key(list),
				this.key('owners', pid)
			],
			[receipt, pid, operation, 0]
		)) as unknown[];
		if (result !== 1) throw new Error('The queue delivery is no longer owned by this worker');
	}

	/** Puts a claimed job back at the end of the queue as a new message with `attempts`. */
	private async requeue({ envelope, receipt }: Claimed, attempts: number): Promise<void> {
		const { pid } = envelope;
		// Reclaiming is for claims without a heartbeat: this one's ends first. The owner key
		// still guards it, so a sweep in between requeues it at most once.
		await this.commands.send('DEL', [this.key('claims', pid)]);
		const moved = await this.script(
			this.commands,
			'reclaim',
			[
				this.key('owners', pid),
				this.key('claims', pid),
				this.key('jobs', pid),
				this.key('processing'),
				this.key('stats', 'processing'),
				this.key('queue')
			],
			[receipt, pid, this.retryPayload(envelope, attempts), 0]
		);
		if (moved !== 1) throw new Error('The queue delivery is no longer owned by this worker');
	}

	/** A message for a job that runs again, with a fresh pid like Broker\Redis's retries. */
	private retryPayload(envelope: Envelope, attempts: number): string {
		return JSON.stringify({
			pid: `${token()}.retry`,
			queue: this.config.name,
			timestamp: Math.floor(Date.now() / 1_000),
			payload: envelope.payload,
			attempts
		});
	}

	private async lease(claimed: Claimed): Promise<Lease | null> {
		const { envelope, receipt } = claimed;
		const details = { queue: this.config.name, pid: envelope.pid, attempts: envelope.attempts };
		let job;
		try {
			job = parseJob(envelope.payload);
		} catch (error) {
			// Every delivery would fail the same way: it goes where the broker puts failures.
			await this.settle(claimed, 'reject');
			this.options.onDiscard?.('invalid job', { ...details, err: error });
			return null;
		}

		// A review outlasts the claim, so it is kept alive until it is settled.
		const heartbeat = setInterval(
			() => {
				this.script(
					this.commands,
					'extend',
					[this.key('claims', envelope.pid), this.key('owners', envelope.pid)],
					[CLAIM_TTL, receipt]
				).catch(() => {});
			},
			(CLAIM_TTL / 3) * 1_000
		);
		let settled = false;
		const settle = async (settlement: () => Promise<void>) => {
			if (settled) return;
			settled = true;
			try {
				await settlement();
			} finally {
				clearInterval(heartbeat);
			}
		};

		const { attempts } = envelope;
		return {
			job,
			attempts,
			maxAttempts: REDIS_MAX_ATTEMPTS,
			ack: () => settle(() => this.settle(claimed, 'commit')),
			nack: ({ retry }) =>
				settle(async () => {
					if (!retry) return this.settle(claimed, 'reject');
					// The queue has no delayed delivery: the job waits here, still claimed, unless
					// the service stops. Out of attempts but still owed one, it starts over.
					const delay = this.options.retryDelayMs ?? ((n) => RETRY_DELAY_MS[n] ?? 300_000);
					await sleep(delay(attempts), this.stopping());
					await this.requeue(claimed, attempts + 1 < REDIS_MAX_ATTEMPTS ? attempts + 1 : 0);
				})
		};
	}

	/**
	 * Recovers what crashed workers left behind, once a minute across all of them, as
	 * Broker\Redis::maintain does for the queues an Appwrite worker serves.
	 */
	private async sweep(): Promise<void> {
		const now = Date.now();
		if (now - this.lastSweep < REAP_INTERVAL * 1_000) return;
		this.lastSweep = now;
		const locked = await this.commands.send('SET', [
			this.key('reap-lock'),
			String(Math.floor(now / 1_000)),
			'NX',
			'EX',
			String(REAP_INTERVAL)
		]);
		if (locked !== 'OK') return;

		// Popped, but never claimed.
		const registry = this.key('reservations');
		const expired = (await this.script(this.commands, 'expired', [registry], [REAP_LIMIT])) as
			string[] | null;
		if (expired?.length) {
			await this.script(
				this.commands,
				'recover',
				[registry, this.key('queue'), ...expired],
				[REAP_LIMIT]
			);
		}

		// Claimed, but neither settled nor kept alive.
		const processing = this.key('processing');
		const cutoff = Math.floor(now / 1_000) - REAP_AFTER;
		const claims = (await this.commands.send('LRANGE', [
			processing,
			String(-REAP_LIMIT),
			'-1'
		])) as string[];
		for (const pid of claims.reverse()) {
			const ownerKey = this.key('owners', pid);
			// Payload before owner: settling deletes both, so one settled meanwhile reads as gone.
			const raw = await this.commands.get(this.key('jobs', pid));
			const owner = await this.commands.get(ownerKey);
			const job = raw === null ? null : decode(raw);
			if (!job) {
				if (owner === null) await this.commands.send('LREM', [processing, '1', pid]);
				else {
					await this.script(
						this.commands,
						'abandon',
						[
							ownerKey,
							this.key('claims', pid),
							this.key('jobs', pid),
							processing,
							this.key('stats', 'processing')
						],
						[owner, pid]
					);
				}
				continue;
			}
			if (job.timestamp > cutoff || (await this.commands.exists(this.key('claims', pid)))) {
				continue;
			}
			await this.script(
				this.commands,
				'reclaim',
				[
					ownerKey,
					this.key('claims', pid),
					this.key('jobs', pid),
					processing,
					this.key('stats', 'processing'),
					this.key('queue')
				],
				[owner ?? '', pid, this.retryPayload(job, job.attempts + 1), 0]
			);
		}
	}
}

interface Claimed {
	envelope: Envelope;
	/** This worker's claim on the message, which settling it proves. */
	receipt: string;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}
