// ============================================================
// IPC input validation guards
// Reusable runtime validators for renderer → main IPC payloads.
// TypeScript types are compile-time only; these guards reject
// malformed or malicious input before it reaches the session runtime.
// ============================================================

import path from "node:path";

export const VALID_AGENT_ID = /^[a-zA-Z0-9_-]{6,64}$/;
export const VALID_PROVIDER = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;

/** Maximum allowed string length to prevent memory exhaustion (100KB). */
const MAX_STRING_LENGTH = 102400;

export function guardString(x: unknown, label: string): string {
	if (typeof x !== "string") {
		throw new Error(`Invalid ${label}: expected string, got ${typeof x}`);
	}
	if (x.length > MAX_STRING_LENGTH) {
		throw new Error(`Invalid ${label}: string exceeds max length ${MAX_STRING_LENGTH}`);
	}
	return x;
}

export function guardOptionalString(x: unknown, label: string): string | undefined {
	if (x === undefined) return undefined;
	return guardString(x, label);
}

/** Like guardOptionalString but also accepts an explicit `null`. Used for
 *  fields that may be cleared (e.g. "use the default" vs. "use this value"). */
export function guardNullableString(x: unknown, label: string): string | null {
	if (x === null) return null;
	return guardString(x, label);
}

export function guardEnum<T extends string>(x: unknown, label: string, values: readonly T[]): T {
	if (!values.includes(x as T)) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(x)} (expected one of ${values.join(", ")})`);
	}
	return x as T;
}

export function guardBoolean(x: unknown, label: string): boolean {
	if (typeof x !== "boolean") {
		throw new Error(`Invalid ${label}: expected boolean, got ${typeof x}`);
	}
	return x;
}

export function guardOptionalBoolean(x: unknown, label: string): boolean | undefined {
	if (x === undefined) return undefined;
	return guardBoolean(x, label);
}

export function guardObject(x: unknown, label: string): Record<string, unknown> {
	if (typeof x !== "object" || x === null || Array.isArray(x)) {
		throw new Error(
			`Invalid ${label}: expected object, got ${x === null ? "null" : Array.isArray(x) ? "array" : typeof x}`,
		);
	}
	return x as Record<string, unknown>;
}

export function guardStringArray(x: unknown, label: string): string[] {
	if (!Array.isArray(x) || !x.every((item) => typeof item === "string")) {
		throw new Error(`Invalid ${label}: expected array of strings`);
	}
	return x;
}

export function guardAgentId(id: unknown, label: string): string {
	if (typeof id !== "string" || !VALID_AGENT_ID.test(id)) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(id)}`);
	}
	return id;
}

export function guardPath(p: unknown, label: string): string {
	if (typeof p !== "string" || p.length === 0 || p.length > 4096) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(p)}`);
	}
	const resolved = path.resolve(p);
	// Reject attempts to traverse above the home directory
	if (resolved.length < 2 || resolved.includes("\0")) {
		throw new Error(`Path traversal rejected: ${JSON.stringify(p)}`);
	}
	return resolved;
}

export function guardProvider(provider: unknown): string {
	if (typeof provider !== "string" || !VALID_PROVIDER.test(provider)) {
		throw new Error(`Invalid provider: ${JSON.stringify(provider)}`);
	}
	return provider;
}
