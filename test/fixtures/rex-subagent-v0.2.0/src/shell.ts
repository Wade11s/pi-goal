/** Quote one value for POSIX sh so spaces, quotes and newlines survive. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
