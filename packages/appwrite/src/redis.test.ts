import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { RedisJobSource, REDIS_MAX_ATTEMPTS } from './redis';

// Against a real Redis server, which CI starts. Messages are written the way Broker\Redis
// publishes them: a JSON envelope pushed on the left of the queue's list.

const url = process.env.HANSI_TEST_REDIS_URL;

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

describe.skipIf(!url)('RedisJobSource', () => {
	let redis: RedisClient;
	let queue: string;
	let count = 0;
	const sources: RedisJobSource[] = [];
	const key = (kind: string, suffix?: string) =>
		`utopia-queue.${kind}.${queue}${suffix === undefined ? '' : `.${suffix}`}`;

	beforeEach(() => {
		redis ??= new RedisClient(url!);
		queue = `v1-reviews-${process.pid}-${++count}`;
	});

	afterAll(async () => {
		await Promise.all(sources.map((source) => source.close()));
		redis?.close();
	});

	function source(discarded: string[] = []) {
		const created = new RedisJobSource(
			{ url: url!, name: queue },
			{ pollMs: 1_000, retryDelayMs: () => 0, onDiscard: (reason) => discarded.push(reason) }
		);
		sources.push(created);
		return created;
	}

	async function publish(payload: unknown, extra: Record<string, unknown> = {}) {
		const pid = `pid-${++count}`;
		const envelope = { pid, queue, timestamp: Math.floor(Date.now() / 1_000), payload, ...extra };
		await redis.send('LPUSH', [key('queue'), JSON.stringify(envelope)]);
		return pid;
	}

	const signal = () => new AbortController().signal;
	const list = (name: string) => redis.send('LRANGE', [key(name), '0', '-1']) as Promise<string[]>;

	test('delivers a job and commits it', async () => {
		const pid = await publish(review);
		const lease = (await source().next(signal()))!;

		expect(lease.job).toMatchObject({ type: 'review', reviewId: 'review1', pullNumber: 42 });
		expect(lease.attempts).toBe(0);
		expect(lease.maxAttempts).toBe(REDIS_MAX_ATTEMPTS);
		expect(await list('processing')).toEqual([pid]);
		expect(await redis.exists(key('claims', pid))).toBe(true);

		await lease.ack();

		expect(await list('processing')).toEqual([]);
		expect(await list('queue')).toEqual([]);
		expect(await redis.exists(key('jobs', pid))).toBe(false);
		expect(await redis.get(key('stats', 'success'))).toBe('1');
	});

	test('waits for a job published while it blocks', async () => {
		const next = source().next(signal());
		await Bun.sleep(100);
		await publish(review);

		const lease = (await next)!;
		expect(lease.job.type).toBe('review');
		await lease.ack();
	});

	test('retries a failed job as a new message with one more attempt', async () => {
		await publish(review);
		const jobs = source();
		const lease = (await jobs.next(signal()))!;

		await lease.nack({ retry: true });

		expect(await list('processing')).toEqual([]);
		const again = (await jobs.next(signal()))!;
		expect(again.attempts).toBe(1);
		expect(again.job).toEqual(lease.job);
		await again.ack();
	});

	test('starts over a job retried past its attempts', async () => {
		await publish(review, { attempts: REDIS_MAX_ATTEMPTS - 1 });
		const jobs = source();
		await (await jobs.next(signal()))!.nack({ retry: true });

		const again = (await jobs.next(signal()))!;
		expect(again.attempts).toBe(0);
		await again.ack();
	});

	test('rejects a job that is not retried onto the failed list, where queue-retry finds it', async () => {
		const pid = await publish(review);
		await (await source().next(signal()))!.nack({ retry: false });

		expect(await list('failed')).toEqual([pid]);
		expect(await list('processing')).toEqual([]);
		expect(await redis.exists(key('jobs', pid))).toBe(true);
	});

	test('sets aside what it cannot read', async () => {
		const discarded: string[] = [];
		const jobs = source(discarded);
		await redis.send('LPUSH', [key('queue'), 'not json']);
		const pid = await publish({ type: 'unknown' });
		await publish(review);

		const lease = (await jobs.next(signal()))!;

		expect(lease.job.type).toBe('review');
		expect(discarded).toEqual(['payload could not be decoded', 'invalid job']);
		expect(await list('poison')).toEqual(['not json']);
		expect(await list('failed')).toEqual([pid]);
		await lease.ack();
	});

	test('returns null once the signal aborts', async () => {
		const controller = new AbortController();
		const next = source().next(controller.signal);
		controller.abort();

		expect(await next).toBeNull();
	});

	test('recovers a message popped by a worker that died before claiming it', async () => {
		const raw = JSON.stringify({ pid: 'stranded', queue, timestamp: 1, payload: review });
		const reservation = key('reservations', 'dead-worker');
		await redis.send('LPUSH', [reservation, raw]);
		await redis.send('ZADD', [key('reservations'), '1', reservation]);

		const lease = (await source().next(signal()))!;

		expect(lease.job.type).toBe('review');
		expect(await redis.exists(reservation)).toBe(false);
		await lease.ack();
	});

	test('requeues a claim nothing keeps alive once it is old enough', async () => {
		const pid = 'abandoned';
		const raw = JSON.stringify({ pid, queue, timestamp: 1, payload: review });
		await redis.set(key('jobs', pid), raw);
		await redis.set(key('owners', pid), 'dead-worker');
		await redis.send('LPUSH', [key('processing'), pid]);

		const lease = (await source().next(signal()))!;

		expect(lease.attempts).toBe(1);
		expect(await redis.exists(key('owners', pid))).toBe(false);
		await lease.ack();
		expect(await list('processing')).toEqual([]);
	});
});
