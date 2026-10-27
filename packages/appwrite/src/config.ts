/** How the service reaches Appwrite. */
export interface AppwriteConfig {
	/** Appwrite's internal API, e.g. `http://appwrite/v1`. Never the public endpoint. */
	endpoint: string;
	/** Shared secret for the internal API, the way the orchestrator uses `_APP_JOBS_SECRET`. */
	secret: string;
	/** Queue the Reviews module publishes to. */
	queue: string;
}

export const REVIEWS_QUEUE = 'v1-reviews';
