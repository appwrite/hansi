import { NotImplementedError, type GitHubClient, type GitHubClientFactory } from '@hansi/engine';
import type { InstallationTokens } from './tokens';

/**
 * GitHub clients authenticated with an installation token. The REST and GraphQL calls (review
 * submission, thread resolution, check runs) land with the engine port.
 */
export class InstallationGitHubClientFactory implements GitHubClientFactory {
	constructor(private readonly tokens: InstallationTokens) {}

	async forRepository(repository: {
		providerInstallationId: string;
		owner: string;
		name: string;
	}): Promise<GitHubClient> {
		await this.tokens.get(repository.providerInstallationId);
		throw new NotImplementedError('InstallationGitHubClientFactory.forRepository');
	}
}
