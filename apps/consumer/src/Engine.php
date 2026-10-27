<?php

declare(strict_types=1);

namespace Hansi\Consumer;

/**
 * The Hansi service, which runs the job of a delivery and answers with its outcome.
 */
interface Engine
{
    /**
     * Runs one delivery to its outcome. Waits while the service is busy; throws when it cannot
     * be reached, so the delivery stays the queue's.
     *
     * @param array<mixed> $payload
     */
    public function run(array $payload, int $attempts, int $maxAttempts): Outcome;
}
