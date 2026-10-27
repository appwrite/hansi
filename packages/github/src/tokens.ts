export interface InstallationToken {
	token: string;
	expiresAt: Date;
}

/**
 * Mints GitHub App installation tokens scoped to one repository: the project's `repositories`
 * row. The app's private key stays with whoever implements it.
 */
export interface InstallationTokens {
	get(repository: { projectId: string; repositoryId: string }): Promise<InstallationToken>;
}
