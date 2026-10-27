<?php

declare(strict_types=1);

namespace Hansi\Consumer;

/**
 * One JSON object per line on stdout, in the shape the service's own logger writes.
 */
final class Log
{
    /**
     * @param array<string, mixed> $fields
     */
    public static function info(string $message, array $fields = []): void
    {
        self::write('info', $message, $fields);
    }

    /**
     * @param array<string, mixed> $fields
     */
    public static function error(string $message, array $fields = []): void
    {
        self::write('error', $message, $fields);
    }

    /**
     * @param array<string, mixed> $fields
     */
    private static function write(string $level, string $message, array $fields): void
    {
        $line = [
            'time' => (new \DateTimeImmutable())->format('Y-m-d\TH:i:s.v\Z'),
            'level' => $level,
            'message' => $message,
            'service' => 'hansi',
            'component' => 'consumer',
            ...$fields,
        ];
        fwrite(STDOUT, json_encode($line, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
    }
}
