<?php

declare(strict_types=1);

namespace Hansi\Consumer\Tests;

use Hansi\Consumer\Broker;
use Hansi\Consumer\Outcome;
use PHPUnit\Framework\TestCase;
use Utopia\NATS\JetStream\ConsumerConfig;

final class BrokerTest extends TestCase
{
    public function testTakesTheOwnersAttemptsWithoutTheSpareDelivery(): void
    {
        $settings = Broker::settings(new ConsumerConfig(
            ackWait: 120.0,
            maxDeliver: 11,
            maxAckPending: 360,
            metadata: ['utopia_queue_spare_delivery' => 'true'],
            backoff: [120.0, 300.0, 900.0],
        ));

        $this->assertSame(
            ['ackWait' => 120.0, 'maxDeliver' => 10, 'backoff' => [120.0, 300.0, 900.0], 'maxAckPending' => 360],
            $settings,
        );
    }

    public function testTakesEveryDeliveryOfAConsumerWithoutASpare(): void
    {
        $this->assertSame(5, Broker::settings(new ConsumerConfig(maxDeliver: 5))['maxDeliver']);
    }

    public function testRetriesWithoutLimitOnAnUnlimitedConsumer(): void
    {
        $settings = Broker::settings(new ConsumerConfig(maxDeliver: -1, backoff: []));

        $this->assertSame(PHP_INT_MAX, $settings['maxDeliver']);
        $this->assertNull($settings['backoff']);
        $this->assertSame(30.0, $settings['ackWait']);
    }

    public function testRefusesAQueueItCannotRead(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        Broker::factory('amqp://rabbit:5672', 'v1-reviews');
    }

    public function testReadsTheServicesOutcomes(): void
    {
        $this->assertSame(Outcome::Done, Outcome::fromResponse(['outcome' => 'done']));
        $this->assertSame(Outcome::Retry, Outcome::fromResponse(['outcome' => 'failed', 'retry' => true]));
        $this->assertSame(Outcome::Dead, Outcome::fromResponse(['outcome' => 'failed', 'retry' => false]));
        $this->assertSame(Outcome::Invalid, Outcome::fromResponse(['outcome' => 'invalid', 'reason' => 'x']));

        $this->expectException(\UnexpectedValueException::class);
        Outcome::fromResponse(['outcome' => 'busy']);
    }
}
