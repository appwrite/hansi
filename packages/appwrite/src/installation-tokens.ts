import { NotImplementedError } from '@hansi/engine';
import type { InstallationToken, InstallationTokens } from '@hansi/github';
import type { AppwriteConfig } from './config';

/**
 * Installation tokens minted by Appwrite, which owns the GitHub App and its private key. The
 * service asks for a token per job and never holds the key itself.
 */
export class AppwriteInstallationTokens implements InstallationTokens {
	constructor(readonly config: AppwriteConfig) {}

	async get(_providerInstallationId: string): Promise<InstallationToken> {
		throw new NotImplementedError('AppwriteInstallationTokens.get');
	}
}
