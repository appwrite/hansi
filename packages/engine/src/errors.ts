/** Thrown by an adapter or handler that is part of the interface but not built yet. */
export class NotImplementedError extends Error {
	override readonly name = 'NotImplementedError';

	constructor(what: string) {
		super(`${what} is not implemented yet`);
	}
}
