import { z } from 'zod';

/** A Cloud region's Appwrite: where its jobs' results go. */
export interface Region {
	/** As Appwrite names it, e.g. `fra1`. */
	id: string;
	endpoint: string;
	secret: string;
}

/** The region of a process that names none: a self-hosted Appwrite, or one Cloud region. */
export const DEFAULT_REGION = 'default';

/**
 * The suffix of a region's own variables, e.g. `HANSI_APPWRITE_ENDPOINT_FRA1` for `fra1`. The
 * consumer reads its queue's the same way (`HANSI_QUEUE_URL_FRA1`, `apps/consumer`).
 */
export function regionSuffix(id: string): string {
	return id.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
}

export interface RegionIssue {
	path: string;
	message: string;
}

const endpoint = z.url();

/**
 * The regions of `HANSI_REGIONS`, each with its own `HANSI_APPWRITE_ENDPOINT_<REGION>` and,
 * unless they share the unsuffixed one, `HANSI_APPWRITE_SECRET_<REGION>`. When `HANSI_REGIONS`
 * is unset, the unsuffixed variables are the only region.
 */
export function parseRegions(source: Record<string, string | undefined>): {
	regions: Region[];
	issues: RegionIssue[];
} {
	const value = (name: string) => (source[name] === '' ? undefined : source[name]);
	const ids = value('HANSI_REGIONS')
		?.split(',')
		.map((id) => id.trim())
		.filter(Boolean) ?? [DEFAULT_REGION];

	const regions: Region[] = [];
	const issues: RegionIssue[] = [];
	const suffixes = new Set<string>();
	for (const id of ids) {
		const suffix = id === DEFAULT_REGION ? '' : `_${regionSuffix(id)}`;
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
			issues.push({ path: 'HANSI_REGIONS', message: `Not a region id: ${id}` });
			continue;
		}
		if (suffixes.has(suffix)) {
			issues.push({ path: 'HANSI_REGIONS', message: `Listed twice: ${id}` });
			continue;
		}
		suffixes.add(suffix);

		// Never another region's: its results would land in the wrong Appwrite.
		const url = value(`HANSI_APPWRITE_ENDPOINT${suffix}`);
		const secret = value(`HANSI_APPWRITE_SECRET${suffix}`) ?? value('HANSI_APPWRITE_SECRET');
		const path = (name: string) => `${name}${suffix}`;
		if (url === undefined) {
			issues.push({ path: path('HANSI_APPWRITE_ENDPOINT'), message: 'Required' });
		} else if (!endpoint.safeParse(url).success) {
			issues.push({ path: path('HANSI_APPWRITE_ENDPOINT'), message: 'Invalid URL' });
		}
		if (secret === undefined) {
			issues.push({ path: path('HANSI_APPWRITE_SECRET'), message: 'Required' });
		}
		if (url !== undefined && secret !== undefined) regions.push({ id, endpoint: url, secret });
	}
	return { regions, issues };
}
