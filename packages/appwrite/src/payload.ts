import type { Job } from '@hansi/engine';
import { z } from 'zod';

// The wire shape of a job on the reviews queue. Appwrite publishes it; parsing it here means a
// payload the service does not understand fails one job loudly instead of the engine guessing.

const id = z.string().min(1);
const providerId = z.union([id, z.number().int().positive().transform(String)]);

const repository = z.object({
	projectId: id,
	projectInternalId: providerId,
	repositoryId: id,
	installationId: id,
	providerInstallationId: providerId,
	providerRepositoryId: providerId,
	owner: id,
	name: id
});

const comment = z.object({
	id: z.number().int().positive(),
	kind: z.enum(['issue', 'review'])
});

const review = z.object({
	type: z.literal('review'),
	reviewId: id,
	repository,
	pullNumber: z.number().int().positive(),
	headSha: z.string().regex(/^[0-9a-f]{40}$/),
	trigger: z.discriminatedUnion('kind', [
		z.object({ kind: z.enum(['opened', 'synchronize', 'ready_for_review', 'retry']) }),
		z.object({ kind: z.literal('mention'), comment })
	])
});

const chat = z.object({
	type: z.literal('chat'),
	repository,
	pullNumber: z.number().int().positive(),
	comment: comment.extend({
		rootCommentId: z.number().int().positive().optional(),
		author: id,
		authorAssociation: id,
		url: z.url()
	}),
	unmentioned: z.boolean().optional()
});

const job = z.discriminatedUnion('type', [review, chat]);

export class InvalidJobError extends Error {
	override readonly name = 'InvalidJobError';
}

export function parseJob(payload: unknown): Job {
	const result = job.safeParse(payload);
	if (!result.success) throw new InvalidJobError(z.prettifyError(result.error));
	return result.data;
}
