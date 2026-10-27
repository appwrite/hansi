<?php

declare(strict_types=1);

namespace Hansi\Consumer\Engine;

use Hansi\Consumer\Engine;
use Hansi\Consumer\Outcome;
use Swoole\Coroutine;
use Swoole\Coroutine\Http\Client;

/**
 * The service's jobs port, on loopback in the same container. One request per delivery,
 * open for as long as its job runs.
 */
final class Http implements Engine
{
    /** Seconds between tries while the service is busy or not listening yet. */
    private const float WAIT = 1.0;

    /** Tries while the service is not listening, before the delivery goes back to the queue. */
    private const int UNREACHABLE_TRIES = 30;

    public function __construct(
        private readonly string $host,
        private readonly int $port,
    ) {
    }

    public function run(array $payload, int $attempts, int $maxAttempts): Outcome
    {
        $body = json_encode(
            ['payload' => $payload, 'attempts' => $attempts, 'maxAttempts' => $maxAttempts],
            JSON_THROW_ON_ERROR,
        );

        $unreachable = 0;
        while (true) {
            $client = new Client($this->host, $this->port);
            // A review takes minutes: no timeout on the answer.
            $client->set(['timeout' => -1, 'connect_timeout' => 5]);
            $client->setHeaders(['Content-Type' => 'application/json']);
            $client->post('/v1/jobs', $body);
            $status = $client->statusCode;
            $response = (string) $client->body;
            $client->close();

            if ($status < 0) {
                // Not listening yet, or gone: the service is this process's parent.
                if (++$unreachable >= self::UNREACHABLE_TRIES) {
                    throw new \RuntimeException("Hansi is not reachable on {$this->host}:{$this->port} (error {$status})");
                }
                Coroutine::sleep(self::WAIT);
                continue;
            }

            // Every slot is taken. The delivery waits here rather than spending an attempt.
            if ($status === 503) {
                Coroutine::sleep(self::WAIT);
                continue;
            }

            if ($status !== 200) {
                throw new \RuntimeException("Hansi answered {$status}: " . substr($response, 0, 500));
            }

            /** @var array<string, mixed> $decoded */
            $decoded = json_decode($response, true, flags: JSON_THROW_ON_ERROR);

            return Outcome::fromResponse($decoded);
        }
    }
}
