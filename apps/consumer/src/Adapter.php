<?php

declare(strict_types=1);

namespace Hansi\Consumer;

use Utopia\Queue\Adapter\Swoole;

/**
 * The Swoole adapter, telling a running handler that shutdown has begun.
 */
final class Adapter extends Swoole
{
    /** In a worker process: set once that worker was told to stop. */
    public function stopping(): bool
    {
        return $this->isStopped();
    }
}
