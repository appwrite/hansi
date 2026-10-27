import type { InstallationToken, InstallationTokens } from '@hansi/github';
import { AppwriteApi } from './api';
import type { AppwriteConfig } from './config';

/**
 * Installation tokens minted by Appwrite, which owns the GitHub App and its private key. Each is
 * scoped to the one repository a review is for; the service never holds the key itself.
 */
export class AppwriteInstallationTokens implements InstallationTokens {
	private readonly api: AppwriteApi;

	constructor(config: AppwriteConfig) {
		this.api = new AppwriteApi(config);
	}

	async get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken> {
		const { token, expiresAt } = await this.api.request<{ token: string; expiresAt: string }>(
			'POST',
			`/reviews/repositories/${encodeURIComponent(repository.repositoryId)}/tokens`,
			{ projectId: repository.projectId }
		);
		return { token, expiresAt: new Date(expiresAt) };
	}
}
