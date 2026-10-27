<?php

declare(strict_types=1);

// Reads review jobs from Appwrite's queue with Appwrite's own queue library and hands each one
// to the Hansi service in the same container (apps/service), which starts this process.

require __DIR__ . '/vendor/autoload.php';

use Hansi\Consumer\Adapter;
use Hansi\Consumer\Broker;
use Hansi\Consumer\Engine\Http;
use Hansi\Consumer\Handler;
use Hansi\Consumer\Log;
use Swoole\Coroutine;
use Utopia\Queue\Message;
use Utopia\Queue\Queue;
use Utopia\Queue\Server;

$env = static function (string $name, ?string $default = null): ?string {
    $value = getenv($name);

    return $value === false || $value === '' ? $default : $value;
};

$url = $env('HANSI_QUEUE_URL');
if ($url === null) {
    Log::error('invalid environment: HANSI_QUEUE_URL is required');
    exit(1);
}
$name = $env('HANSI_QUEUE_NAME', 'v1-reviews');
$concurrency = max(1, (int) $env('HANSI_CONCURRENCY', '4'));
$port = (int) $env('HANSI_JOBS_PORT', '8081');
// How long a stopping consumer waits for running jobs before it gives their deliveries back.
$shutdownTimeout = (float) $env('HANSI_SHUTDOWN_TIMEOUT', '3600');

$broker = Broker::factory($url, $name, $env('HANSI_QUEUE_USER'), $env('HANSI_QUEUE_PASSWORD'));
$queue = new Queue($name);

$adapter = new Adapter($broker, workerNum: 1, shutdownTimeout: $shutdownTimeout);
$server = new Server($adapter);

// One per worker process, for the few jobs that go back on the queue as new messages.
$publisher = null;

$server
    ->job($name, $concurrency)
    ->inject('message')
    ->action(function (Message $message) use ($adapter, $broker, &$publisher, $queue, $port): void {
        $publisher ??= $broker();
        $handler = new Handler(
            new Http('127.0.0.1', $port),
            $publisher,
            $queue,
            static function (float $seconds) use ($adapter): bool {
                for ($left = $seconds; $left > 0 && !$adapter->stopping(); $left -= 1.0) {
                    Coroutine::sleep(min(1.0, $left));
                }

                return !$adapter->stopping();
            },
        );
        $handler($message);
    });

$server
    ->error()
    ->inject('error')
    ->action(function (\Throwable $error) use ($name): void {
        Log::error('queue job failed', [
            'queue' => $name,
            'err' => ['name' => $error::class, 'message' => $error->getMessage()],
        ]);
    });

$server
    ->workerStart()
    ->action(function () use ($name, $concurrency): void {
        Log::info('queue consumer started', ['queue' => $name, 'concurrency' => $concurrency]);
    });

$server->start();
