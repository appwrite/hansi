<?php

declare(strict_types=1);

namespace Hansi\Consumer;

use Utopia\DSN\DSN;
use Utopia\NATS\Connection as NatsConnection;
use Utopia\NATS\ConnectionOptions;
use Utopia\NATS\JetStream\ConsumerConfig;
use Utopia\Queue\Broker\Nats;
use Utopia\Queue\Broker\Provisioning;
use Utopia\Queue\Broker\Redis;
use Utopia\Queue\Codec\Compat;
use Utopia\Queue\Connection\Locking;
use Utopia\Queue\Connection\Redis as RedisConnection;
use Utopia\Queue\Consumer;
use Utopia\Queue\Publisher\Synchronous;

/**
 * The broker for Appwrite's queue, which its URL names: NATS JetStream on Cloud, Redis on a
 * self-hosted Appwrite. The queue is Appwrite's: this consumer takes up what Appwrite's
 * publisher provisioned and never changes its configuration.
 */
final class Broker
{
    /** The durable work consumer every worker of a queue shares, as Broker\Nats names it. */
    private const string WORK_CONSUMER = 'worker';

    /** Marks a work consumer that allows one delivery past the owner's attempts. */
    private const string SPARE_DELIVERY = 'utopia_queue_spare_delivery';

    /** Times a Redis claim whose worker died is requeued before it goes to the dead list. */
    private const int REAP_ATTEMPTS = Handler::ATTEMPTS;

    /**
     * @return \Closure(): (Consumer&Synchronous) One broker per call: a connection belongs to
     *         the worker process that opened it.
     */
    public static function factory(string $url, string $queue, ?string $user = null, ?string $password = null): \Closure
    {
        $dsn = new DSN($url);
        $user = self::filled($user) ?? self::filled($dsn->getUser());
        $password = self::filled($password) ?? self::filled($dsn->getPassword());

        return match ($dsn->getScheme()) {
            'nats' => self::nats($dsn, $queue, $user, $password),
            'redis' => self::redis($dsn, $user, $password),
            default => throw new \InvalidArgumentException("Not a queue this consumer can read: {$dsn->getScheme()}://"),
        };
    }

    /**
     * The settings that decide attempts and backoff live on the consumer its owner provisioned.
     * A broker that only adopts the queue still applies its own, so they are read from there.
     *
     * @return \Closure(): Nats
     */
    private static function nats(DSN $dsn, string $queue, ?string $user, ?string $password): \Closure
    {
        $options = new ConnectionOptions(
            servers: 'nats://' . $dsn->getHost() . ':' . ($dsn->getPort() ?? '4222'),
            name: 'hansi',
            user: $user,
            pass: $password,
        );
        $connect = static fn (): NatsConnection => NatsConnection::connect($options);

        $connection = $connect();
        try {
            $stream = 'Q_' . strtoupper((string) preg_replace('/[^A-Za-z0-9_-]/', '_', $queue));
            $config = $connection->jetStream()->getConsumer($stream, self::WORK_CONSUMER)->info()->config;
        } catch (\Throwable $error) {
            throw new \RuntimeException("Queue {$queue} is not provisioned on NATS: Appwrite creates it on its first publish", previous: $error);
        } finally {
            $connection->close();
        }
        $settings = self::settings($config);

        return static fn (): Nats => new Nats(
            $connect,
            ackWait: $settings['ackWait'],
            maxDeliver: $settings['maxDeliver'],
            backoff: $settings['backoff'],
            maxAckPending: $settings['maxAckPending'],
            provisioning: Provisioning::Require,
            codec: new Compat(),
        );
    }

    /**
     * What a work consumer's configuration means for a broker that adopts it.
     *
     * @return array{ackWait: float, maxDeliver: int, backoff: list<float>|null, maxAckPending: int|null}
     */
    public static function settings(ConsumerConfig $config): array
    {
        $allowed = $config->maxDeliver ?? -1;
        $spare = isset($config->metadata[self::SPARE_DELIVERY]) && $allowed >= 1;

        return [
            'ackWait' => $config->ackWait ?? 30.0,
            // Broker\Nats has no unlimited setting: a consumer without a limit gets the largest.
            'maxDeliver' => $allowed < 1 ? PHP_INT_MAX : ($spare ? $allowed - 1 : $allowed),
            'backoff' => $config->backoff === null || $config->backoff === [] ? null : array_values($config->backoff),
            'maxAckPending' => $config->maxAckPending,
        ];
    }

    /**
     * @return \Closure(): Redis
     */
    private static function redis(DSN $dsn, ?string $user, ?string $password): \Closure
    {
        $host = $dsn->getHost();
        $port = (int) ($dsn->getPort() ?? 6379);

        return static fn (): Redis => new Redis(
            receive: new RedisConnection($host, $port, $user, $password),
            commands: new Locking(new RedisConnection($host, $port, $user, $password)),
            codec: new Compat(),
            reapMaxAttempts: self::REAP_ATTEMPTS,
        );
    }

    /** Compose passes every variable it lists, so an empty one is unset. */
    private static function filled(?string $value): ?string
    {
        return $value === null || $value === '' ? null : $value;
    }
}
