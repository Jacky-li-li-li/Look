/**
 * Generate a stable React key from a string without relying on array indices.
 * Uses a simple djb2 hash so repeated identical content does not change the key.
 */
export function hashKey(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
	}
	return hash.toString(36);
}
