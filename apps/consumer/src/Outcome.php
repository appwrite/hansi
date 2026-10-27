<?php

declare(strict_types=1);

namespace Hansi\Consumer;

/**
 * What became of a delivery, as the service decides it. Mirrors `Outcome` in
 * `apps/service/src/worker.ts`.
 */
enum Outcome
{
    /** The job is done, whatever its outcome on GitHub. */
    case Done;

    /** The job failed and another delivery is worth it. */
    case Retry;

    /** The job failed for good: it belongs with the queue's dead letters. */
    case Dead;

    /** No delivery of this payload can succeed. */
    case Invalid;

    /**
     * @param array<string, mixed> $body
     */
    public static function fromResponse(array $body): self
    {
        return match ($body['outcome'] ?? null) {
            'done' => self::Done,
            'failed' => ($body['retry'] ?? false) === true ? self::Retry : self::Dead,
            'invalid' => self::Invalid,
            default => throw new \UnexpectedValueException('Unknown outcome: ' . json_encode($body)),
        };
    }
}
