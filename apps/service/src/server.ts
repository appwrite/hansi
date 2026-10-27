/**
 * Liveness and readiness for the cluster. Readiness drops as soon as shutdown starts, so no
 * new traffic is routed here while running jobs finish.
 */
export function startHealthServer(options: { port: number; draining: () => boolean }) {
	return Bun.serve({
		port: options.port,
		routes: {
			'/healthz': new Response('ok'),
			'/readyz': () =>
				options.draining() ? new Response('draining', { status: 503 }) : new Response('ok')
		},
		fetch: () => new Response('not found', { status: 404 })
	});
}
