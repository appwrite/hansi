<?php

declare(strict_types=1);

namespace Hansi\Consumer;

use Utopia\Queue\Message;
use Utopia\Queue\PermanentFailure;
use Utopia\Queue\Publisher\Synchronous;
use Utopia\Queue\Queue;

/**
 * Hands each delivery to the service and settles it by the outcome.
 *
 * Returning commits the delivery, `PermanentFailure` puts it with the dead letters, and any other
 * exception leaves it to the broker's own redelivery. JetStream counts deliveries and backs off
 * between them. Redis does neither: a rejected message waits on the failed list for an operator,
 * so on Redis the attempts run here, in one delivery, with the waits between them. A wait cut
 * short by shutdown gives the job back as a new message rather than hold the worker up.
 */
final class Handler
{
    /** Attempts a job gets on a queue that does not count deliveries. */
    public const int ATTEMPTS = 3;

    /** Seconds before the next attempt on such a queue, by the attempts made so far. */
    public const array DELAYS = [10, 60, 300];

    /**
     * @param \Closure(float): bool $wait Waits that many seconds; false when shutdown cut it short.
     * @param list<int> $delays
     */
    public function __construct(
        private readonly Engine $engine,
        private readonly Synchronous $publisher,
        private readonly Queue $queue,
        private readonly \Closure $wait,
        private readonly array $delays = self::DELAYS,
    ) {
    }

    public function __invoke(Message $message): void
    {
        $payload = $message->getPayload();
        $attempts = $message->getAttempts();
        // Set by a broker that counts deliveries and redelivers on its own.
        $redelivers = $message->getMaxAttempts() !== null;
        $maxAttempts = $message->getMaxAttempts() ?? self::ATTEMPTS;

        while (true) {
            $outcome = $this->engine->run($payload, $attempts, $maxAttempts);

            switch ($outcome) {
                case Outcome::Done:
                    return;
                case Outcome::Invalid:
                    throw new PermanentFailure('The job payload is invalid');
                case Outcome::Dead:
                    throw new PermanentFailure('The job failed');
                case Outcome::Retry:
                    if ($attempts + 1 < $maxAttempts) {
                        if ($redelivers) {
                            throw new \RuntimeException('The job failed and is retried');
                        }
                        $delay = $this->delays[$attempts] ?? $this->delays[\count($this->delays) - 1];
                        if (($this->wait)((float) $delay)) {
                            $attempts++;
                            continue 2;
                        }
                    }
                    // Out of attempts but still owed one, to record the failure, or stopping: the job
                    // goes back as a new message with attempts of its own.
                    $this->publisher->publish($this->queue, $payload);

                    return;
            }
        }
    }
}
