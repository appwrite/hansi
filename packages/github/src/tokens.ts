export interface InstallationToken {
	token: string;
	expiresAt: Date;
}

/** Mints GitHub App installation tokens. The app's private key stays with whoever implements it. */
export interface InstallationTokens {
	get(providerInstallationId: string): Promise<InstallationToken>;
}
