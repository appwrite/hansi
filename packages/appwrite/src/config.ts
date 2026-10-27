/** How the service reaches Appwrite. */
export interface AppwriteConfig {
	/** Appwrite's internal API, e.g. `http://appwrite/v1`. Never the public endpoint. */
	endpoint: string;
	/** Shared secret for the internal API, the way the orchestrator uses `_APP_JOBS_SECRET`. */
	secret: string;
}

/** The queue the Reviews module publishes to. */
export const REVIEWS_QUEUE = 'v1-reviews';
