// One JSON object per line on stdout, which is what the cluster's log shipping expects.

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof levels;
type Fields = Record<string, unknown>;

export interface Logger {
	debug(message: string, fields?: Fields): void;
	info(message: string, fields?: Fields): void;
	warn(message: string, fields?: Fields): void;
	error(message: string, fields?: Fields): void;
	child(fields: Fields): Logger;
}

export function createLogger(
	level: Level,
	base: Fields = {},
	write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Logger {
	const log =
		(at: Level) =>
		(message: string, fields: Fields = {}) => {
			if (levels[at] < levels[level]) return;
			write(
				JSON.stringify(
					{ time: new Date().toISOString(), level: at, message, ...base, ...fields },
					(_, value) =>
						value instanceof Error
							? { name: value.name, message: value.message, stack: value.stack }
							: value
				)
			);
		};
	return {
		debug: log('debug'),
		info: log('info'),
		warn: log('warn'),
		error: log('error'),
		child: (fields) => createLogger(level, { ...base, ...fields }, write)
	};
}
