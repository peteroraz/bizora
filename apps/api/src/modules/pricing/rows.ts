/** Rows of a raw query, whichever driver ran it (postgres-js gives an array, PGlite an object with rows). */
export const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
