import { z } from 'zod';
import type { Worker } from './worker';

/**
 * Liveness and readiness for the cluster. Readiness drops as soon as shutdown starts, so no
 * new traffic is routed here while running jobs finish.
 */
export function startHealthServer(options: { port: number; ready: () => boolean }) {
	return Bun.serve({
		port: options.port,
		routes: {
			'/healthz': new Response('ok'),
			'/readyz': () =>
				options.ready() ? new Response('ok') : new Response('draining', { status: 503 })
		},
		fetch: () => new Response('not found', { status: 404 })
	});
}

const delivery = z.object({
	payload: z.unknown(),
	attempts: z.number().int().nonnegative(),
	maxAttempts: z.number().int().positive()
});

/**
 * Where the queue consumer hands over each delivery, on loopback only: the consumer runs in
 * the same container. The request lasts as long as the job, and its answer is the outcome
 * the consumer settles the delivery by. It takes jobs during shutdown too: the consumer stops
 * receiving first, and what it still sends belongs to a delivery it holds.
 */
export function startJobsServer(options: { port: number; hostname?: string; worker: Worker }) {
	const busy = () => Response.json({ outcome: 'busy' }, { status: 503 });
	return Bun.serve({
		port: options.port,
		hostname: options.hostname ?? '127.0.0.1',
		// A review takes minutes; the connection stays open until its outcome is known.
		idleTimeout: 0,
		routes: {
			'/v1/jobs': {
				POST: async (request) => {
					const body = delivery.safeParse(await request.json().catch(() => undefined));
					if (!body.success) {
						return Response.json({ message: z.prettifyError(body.error) }, { status: 400 });
					}
					// Not tied to the request: a consumer that went away takes the container with it.
					const outcome = await options.worker.run(body.data);
					return outcome ? Response.json(outcome) : busy();
				}
			}
		},
		fetch: () => new Response('not found', { status: 404 })
	});
}
