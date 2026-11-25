import type { InstallationToken, InstallationTokens } from '@hansi/github';
import { AppwriteApi } from './api';
import type { AppwriteConfig } from './config';

/**
 * Installation tokens minted by Appwrite, which owns the GitHub and Origin apps and their private
 * keys, and the OAuth tokens of GitLab, Gitea and Bitbucket installations. Each is scoped to the
 * one repository a review is for; the service never holds a key itself.
 */
export class AppwriteInstallationTokens implements InstallationTokens {
	private readonly api: AppwriteApi;

	constructor(config: AppwriteConfig) {
		this.api = new AppwriteApi(config);
	}

	async get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken> {
		const { token, expiresAt, appId, appSlug, endpoint } = await this.api.request<{
			token: string;
			expiresAt: string;
			appId: string;
			appSlug: string;
			/** A self-hosted GitLab or Gitea's API root. */
			endpoint?: string;
		}>('POST', `/reviews/repositories/${encodeURIComponent(repository.repositoryId)}/tokens`, {
			projectId: repository.projectId
		});
		return {
			token,
			expiresAt: new Date(expiresAt),
			app: { id: appId, slug: appSlug },
			...(endpoint ? { endpoint } : {})
		};
	}
}
