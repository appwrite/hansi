<?php

declare(strict_types=1);

namespace Hansi\Consumer\Tests;

use Hansi\Consumer\Region;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class RegionTest extends TestCase
{
    /** @return iterable<string, array{string|null, string}> */
    public static function regions(): iterable
    {
        yield 'none' => [null, 'HANSI_QUEUE_URL'];
        yield 'plain' => ['fra1', 'HANSI_QUEUE_URL_FRA1'];
        yield 'dashed' => ['sfo-2', 'HANSI_QUEUE_URL_SFO_2'];
    }

    #[DataProvider('regions')]
    public function testNamesTheRegionsVariable(?string $region, string $variable): void
    {
        $this->assertSame($variable, Region::variable('HANSI_QUEUE_URL', $region));
    }
}
