<?php

declare(strict_types=1);

namespace Hansi\Consumer;

/**
 * The Cloud region whose queue this consumer reads, which the service names in `HANSI_REGION`
 * when it serves several: the service sends each job's results to that region's Appwrite.
 * Its queue is in variables suffixed with the region, as the service names its Appwrite's
 * (`apps/service/src/regions.ts`): `HANSI_QUEUE_URL_FRA1` for `fra1`.
 */
final class Region
{
    /** The variable that holds `$name` for the region, the unsuffixed one without a region. */
    public static function variable(string $name, ?string $region): string
    {
        if ($region === null) {
            return $name;
        }
        $suffix = strtoupper($region);
        for ($i = 0, $length = \strlen($suffix); $i < $length; $i++) {
            if (!ctype_alnum($suffix[$i])) {
                $suffix[$i] = '_';
            }
        }

        return "{$name}_{$suffix}";
    }
}
