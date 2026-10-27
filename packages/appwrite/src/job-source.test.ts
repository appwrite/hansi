import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
	AckPolicy,
	jetstream,
	jetstreamManager,
	RetentionPolicy,
	type JetStreamManager
} from '@nats-io/jetstream';
import { connect, headers, type NatsConnection } from '@nats-io/transport-node';
import { xxhash128 } from 'hash-wasm';
import { AppwriteJobSource } from './job-source';
import { queueNames, SPARE_DELIVERY_METADATA, WORK_CONSUMER, WORK_SEQUENCE } from './queue';

// Against a real NATS server with JetStream (`nats-server -js`), which CI starts. Each test
// provisions its queue the way Broker\Nats does on Appwrite's first publish.

const url = process.env.HANSI_TEST_NATS_URL;
const ms = (n: number) => n * 1_000_000;

const review = {
	type: 'review',
	reviewId: 'review1',
	repository: {
		projectId: 'project1',
		projectInternalId: '1',
		repositoryId: 'repo1',
		installationId: 'installation1',
		providerInstallationId: '2',
		providerRepositoryId: '3',
		owner: 'appwrite',
		name: 'appwrite'
	},
	pullNumber: 42,
	headSha: 'a'.repeat(40),
	trigger: { kind: 'synchronize' }
};

describe.skipIf(!url)('AppwriteJobSource on NATS', () => {
	let nc: NatsConnection;
	let jsm: JetStreamManager;
	let queue: string;
	let names: ReturnType<typeof queueNames>;
	const sources: AppwriteJobSource[] = [];
	let count = 0;

	beforeEach(async () => {
		nc ??= await connect({ servers: url!.replace(/^nats:\/\//, '') });
		jsm ??= await jetstreamManager(nc);
		queue = `v1-reviews-${process.pid}-${++count}`;
		names = queueNames(queue);
	});

	afterAll(async () => {
		await Promise.all(sources.map((source) => source.close()));
		await nc?.close();
	});

	/** The streams and work consumer Broker\Nats provisions, with three attempts. */
	async function provision(ackWait = 1_000) {
		await jsm.streams.add({
			name: names.workStream,
			subjects: [names.workSubject],
			retention: RetentionPolicy.Workqueue,
			duplicate_window: ms(60_000)
		});
		await jsm.streams.add({
			name: names.deadStream,
			subjects: [names.deadSubject, `${names.deadSubject}.>`],
			retention: RetentionPolicy.Workqueue
		});
		await jsm.consumers.add(names.workStream, {
			durable_name: WORK_CONSUMER,
			ack_policy: AckPolicy.Explicit,
			ack_wait: ms(ackWait),
			max_deliver: 4,
			filter_subject: names.workSubject,
			backoff: [ms(ackWait)],
			metadata: { [SPARE_DELIVERY_METADATA]: '1' }
		});
	}

	async function publish(payload: unknown, contentType = 'application/json', pid = 'pid1') {
		const envelope = { pid, queue, timestamp: 1, payload };
		const meta = headers();
		meta.set('Content-Type', contentType);
		await jetstream(nc).publish(names.workSubject, JSON.stringify(envelope), { headers: meta });
	}

	function source(onDiscard?: (reason: string) => void) {
		const created = new AppwriteJobSource({ url: url!, name: queue }, { pollMs: 1_000, onDiscard });
		sources.push(created);
		return created;
	}

	/** Messages on a stream once it settles: the server removes a settled message soon after. */
	async function messages(stream: string, expected: number): Promise<number> {
		let stored = -1;
		for (let i = 0; i < 20 && stored !== expected; i++) {
			if (i) await Bun.sleep(50);
			stored = (await jsm.streams.info(stream)).state.messages;
		}
		return stored;
	}
	const soon = () => AbortSignal.timeout(4_000);

	test('refuses a queue Appwrite has not provisioned', async () => {
		await expect(source().next(soon())).rejects.toThrow(/is not provisioned/);
	});

	test('delivers a job and removes it once acked', async () => {
		await provision();
		await publish(review);

		const lease = await source().next(soon());

		expect(lease?.job).toMatchObject({ type: 'review', reviewId: 'review1' });
		expect(lease?.attempts).toBe(0);
		expect(lease?.maxAttempts).toBe(3);
		await lease!.ack();
		expect(await messages(names.workStream, 0)).toBe(0);
	});

	test('redelivers a job nacked for a retry, counting the attempt', async () => {
		await provision();
		await publish(review);
		const jobs = source();

		await (await jobs.next(soon()))!.nack({ retry: true });
		const again = await jobs.next(soon());

		expect(again?.attempts).toBe(1);
		await again!.ack();
	});

	test('dead-letters a job nacked without a retry where the broker re-drives it', async () => {
		await provision();
		await publish(review);

		const lease = await source().next(soon());
		await lease!.nack({ retry: false });

		expect(await messages(names.workStream, 0)).toBe(0);
		const dead = await jsm.streams.getMessage(names.deadStream, { seq: 1 });
		expect(dead?.header.get(WORK_SEQUENCE)).toBe('1');
		const keyed = new Uint8Array([...new TextEncoder().encode('pid1.dead.1\n'), ...dead!.data]);
		expect(dead?.subject).toBe(`${names.deadSubject}.${await xxhash128(keyed)}`);
		expect(dead?.json<{ payload: unknown }>().payload).toEqual(review);
	});

	test('dead-letters a job on its last attempt even when asked to retry', async () => {
		await provision();
		await publish(review);
		const jobs = source();

		let lease = await jobs.next(soon());
		while (lease && lease.attempts + 1 < lease.maxAttempts) {
			await lease.nack({ retry: true });
			lease = await jobs.next(soon());
		}
		expect(lease?.attempts).toBe(2);
		await lease!.nack({ retry: true });

		expect(await messages(names.workStream, 0)).toBe(0);
		expect(await messages(names.deadStream, 1)).toBe(1);
	});

	test('keeps a long job from being delivered again', async () => {
		await provision(500);
		await publish(review);
		const jobs = source();

		const lease = await jobs.next(soon());
		// Three ack waits: without keepalives the job would be redelivered meanwhile.
		const other = await jobs.next(AbortSignal.timeout(1_500));

		expect(other).toBeNull();
		await lease!.ack();
	});

	test('sets aside a job it cannot parse and takes the next one', async () => {
		await provision();
		await publish({ type: 'deploy' }, 'application/json', 'bad');
		await publish(review, 'application/json', 'good');
		const discarded: string[] = [];

		const lease = await source((reason) => discarded.push(reason)).next(soon());

		expect(lease?.job).toMatchObject({ reviewId: 'review1' });
		expect(discarded).toEqual(['invalid job']);
		expect(await messages(names.deadStream, 1)).toBe(1);
		await lease!.ack();
	});

	test('parks a message in a codec it cannot read, unread', async () => {
		await provision();
		await publish(review, 'application/vnd.php.igbinary');
		const discarded: string[] = [];

		const lease = await source((reason) => discarded.push(reason)).next(AbortSignal.timeout(1_000));

		expect(lease).toBeNull();
		expect(discarded).toEqual(['payload could not be decoded']);
		const parked = await jsm.streams.getMessage(names.deadStream, { seq: 1 });
		expect(parked?.subject).toBe(names.deadSubject);
		expect(parked?.header.get('Content-Type')).toBe('application/vnd.php.igbinary');
	});

	test('dead-letters a job whose every worker died, on the spare delivery', async () => {
		await provision(500);
		await publish(review);

		// Each worker takes the job and goes away without settling it.
		for (let attempt = 0; attempt < 3; attempt++) {
			const dying = source();
			expect((await dying.next(soon()))?.attempts).toBe(attempt);
			await dying.close();
		}
		const discarded: string[] = [];
		const lease = await source((reason) => discarded.push(reason)).next(AbortSignal.timeout(2_500));

		expect(lease).toBeNull();
		expect(discarded).toEqual(['max deliveries exceeded']);
		expect(await messages(names.workStream, 0)).toBe(0);
		expect((await jsm.streams.getMessage(names.deadStream, { seq: 1 }))?.subject).toBe(
			names.deadSubject
		);
	}, 15_000);

	test('hands back a job that arrives once shutdown began, without spending an attempt', async () => {
		await provision();
		const controller = new AbortController();
		const stopping = source();

		const next = stopping.next(controller.signal);
		await Bun.sleep(300);
		controller.abort();
		await publish(review);

		expect(await next).toBeNull();
		const lease = await source().next(soon());
		expect(lease?.attempts).toBe(0);
		await lease!.ack();
	});

	test('stops waiting once the signal aborts', async () => {
		await provision();
		const controller = new AbortController();

		const next = source().next(controller.signal);
		controller.abort();

		expect(await next).toBeNull();
	});
});
