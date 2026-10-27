/** How the service reaches Appwrite. */
export interface AppwriteConfig {
	/** Appwrite's internal API, e.g. `http://appwrite/v1`. Never the public endpoint. */
	endpoint: string;
	/** Appwrite's `_APP_REVIEWS_SECRET`, sent as `X-Appwrite-Reviews-Secret`. */
	secret: string;
	fetch?: typeof fetch;
}
