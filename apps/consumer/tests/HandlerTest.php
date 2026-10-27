<?php

declare(strict_types=1);

namespace Hansi\Consumer\Tests;

use Hansi\Consumer\Engine;
use Hansi\Consumer\Handler;
use Hansi\Consumer\Outcome;
use PHPUnit\Framework\TestCase;
use Utopia\Queue\Message;
use Utopia\Queue\PermanentFailure;
use Utopia\Queue\Publisher\Synchronous;
use Utopia\Queue\Queue;

/** Answers with the outcomes it was given, in order, and records what it was asked. */
final class ScriptedEngine implements Engine
{
    /** @var list<array{attempts: int, maxAttempts: int}> */
    public array $runs = [];

    /** @param list<Outcome> $outcomes */
    public function __construct(private array $outcomes)
    {
    }

    public function run(array $payload, int $attempts, int $maxAttempts): Outcome
    {
        $this->runs[] = ['attempts' => $attempts, 'maxAttempts' => $maxAttempts];

        return array_shift($this->outcomes) ?? throw new \LogicException('No outcome left');
    }
}

/** Keeps what is published instead of sending it anywhere. */
final class MemoryPublisher implements Synchronous
{
    /** @var list<array<mixed>> */
    public array $published = [];

    public function publish(Queue $queue, array $payload): bool
    {
        $this->published[] = $payload;

        return true;
    }

    public function publishMany(Queue $queue, array $payloads): bool
    {
        array_push($this->published, ...$payloads);

        return true;
    }

    public function retry(Queue $queue, ?int $limit = null): void
    {
    }

    public function getQueueSize(Queue $queue, bool $failedJobs = false): int
    {
        return 0;
    }

    public function getFailedCount(Queue $queue): int
    {
        return 0;
    }
}

final class HandlerTest extends TestCase
{
    private const array PAYLOAD = ['type' => 'review', 'reviewId' => 'review1'];

    /** @var list<float> */
    private array $slept = [];

    private MemoryPublisher $publisher;

    private bool $stopping = false;

    protected function setUp(): void
    {
        $this->slept = [];
        $this->stopping = false;
        $this->publisher = new MemoryPublisher();
    }

    private function handler(ScriptedEngine $engine): Handler
    {
        return new Handler($engine, $this->publisher, new Queue('v1-reviews'), function (float $seconds): bool {
            $this->slept[] = $seconds;

            return !$this->stopping;
        });
    }

    /** A delivery as Broker\Nats hands it over: it counts deliveries. */
    private function nats(int $attempts, int $maxAttempts = 3): Message
    {
        return new Message(['pid' => 'p', 'queue' => 'v1-reviews', 'timestamp' => 0, 'payload' => self::PAYLOAD])
            ->setAttempts($attempts)
            ->setMaxAttempts($maxAttempts);
    }

    /** A delivery as Broker\Redis hands it over: no limit of its own. */
    private function redis(int $attempts = 0): Message
    {
        return new Message(['pid' => 'p', 'queue' => 'v1-reviews', 'timestamp' => 0, 'payload' => self::PAYLOAD, 'attempts' => $attempts]);
    }

    public function testCommitsADoneJob(): void
    {
        $engine = new ScriptedEngine([Outcome::Done]);

        $this->handler($engine)($this->nats(0));

        $this->assertSame([['attempts' => 0, 'maxAttempts' => 3]], $engine->runs);
        $this->assertSame([], $this->publisher->published);
    }

    public function testDeadLettersAnInvalidPayload(): void
    {
        $this->expectException(PermanentFailure::class);

        $this->handler(new ScriptedEngine([Outcome::Invalid]))($this->nats(0));
    }

    public function testDeadLettersAJobThatFailedForGood(): void
    {
        $this->expectException(PermanentFailure::class);

        $this->handler(new ScriptedEngine([Outcome::Dead]))($this->redis());
    }

    public function testLeavesARetryToJetStream(): void
    {
        $engine = new ScriptedEngine([Outcome::Retry]);

        try {
            $this->handler($engine)($this->nats(1));
            $this->fail('A retried job must not be committed');
        } catch (PermanentFailure) {
            $this->fail('A retried job must not be dead-lettered');
        } catch (\RuntimeException) {
        }

        $this->assertCount(1, $engine->runs);
        $this->assertSame([], $this->slept);
    }

    public function testRetriesOnRedisWithItsWaits(): void
    {
        $engine = new ScriptedEngine([Outcome::Retry, Outcome::Retry, Outcome::Done]);

        $this->handler($engine)($this->redis());

        $this->assertSame(
            [['attempts' => 0, 'maxAttempts' => 3], ['attempts' => 1, 'maxAttempts' => 3], ['attempts' => 2, 'maxAttempts' => 3]],
            $engine->runs,
        );
        $this->assertSame([10.0, 60.0], $this->slept);
    }

    public function testContinuesFromTheAttemptsARedisMessageCarries(): void
    {
        $engine = new ScriptedEngine([Outcome::Retry, Outcome::Done]);

        $this->handler($engine)($this->redis(1));

        $this->assertSame([1, 2], array_column($engine->runs, 'attempts'));
        $this->assertSame([60.0], $this->slept);
    }

    public function testStartsOverAJobStillOwedADelivery(): void
    {
        $this->handler(new ScriptedEngine([Outcome::Retry]))($this->nats(2));

        $this->assertSame([self::PAYLOAD], $this->publisher->published);
    }

    public function testStartsOverOnRedisOnceOutOfAttempts(): void
    {
        $this->handler(new ScriptedEngine([Outcome::Retry, Outcome::Retry, Outcome::Retry]))($this->redis());

        $this->assertSame([self::PAYLOAD], $this->publisher->published);
        $this->assertSame([10.0, 60.0], $this->slept);
    }

    public function testGivesTheJobBackWhenShutdownCutsAWaitShort(): void
    {
        $this->stopping = true;
        $engine = new ScriptedEngine([Outcome::Retry]);

        $this->handler($engine)($this->redis());

        $this->assertCount(1, $engine->runs);
        $this->assertSame([self::PAYLOAD], $this->publisher->published);
    }
}
