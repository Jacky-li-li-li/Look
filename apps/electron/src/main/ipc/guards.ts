// ============================================================
// IPC input validation guards
// Reusable runtime validators for renderer → main IPC payloads.
// TypeScript types are compile-time only; these guards reject
// malformed or malicious input before it reaches the session runtime.
// ============================================================

import path from "node:path";
import type { AgentDefinitionInput } from "@look/shared/types";
import type { McpServerConfig } from "../mcp/types.js";
import type { CustomProviderInput } from "../settings/custom-providers.js";

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

export function guardNumber(x: unknown, label: string, opts?: { min?: number; max?: number }): number {
	if (typeof x !== "number" || !Number.isFinite(x)) {
		throw new Error(`Invalid ${label}: expected finite number, got ${typeof x}`);
	}
	if (opts?.min !== undefined && x < opts.min) {
		throw new Error(`Invalid ${label}: must be >= ${opts.min}`);
	}
	if (opts?.max !== undefined && x > opts.max) {
		throw new Error(`Invalid ${label}: must be <= ${opts.max}`);
	}
	return x;
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

export function guardPath(p: unknown, label: string, baseDir?: string): string {
	if (typeof p !== "string" || p.length === 0 || p.length > 4096) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(p)}`);
	}
	const resolved = path.resolve(p);
	if (resolved.length < 2 || resolved.includes("\0")) {
		throw new Error(`Path traversal rejected: ${JSON.stringify(p)}`);
	}
	if (baseDir) {
		const rel = path.relative(baseDir, resolved);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`Path traversal denied for ${label}: outside allowed directory`);
		}
	}
	return resolved;
}

export function guardProvider(provider: unknown): string {
	if (typeof provider !== "string" || !VALID_PROVIDER.test(provider)) {
		throw new Error(`Invalid provider: ${JSON.stringify(provider)}`);
	}
	return provider;
}

/**
 * 校验自定义 Provider 输入的基本结构。
 * 详细校验由 CustomProvidersStore.add/update 内部的 assertValid 完成。
 */
export function guardCustomProviderInput(x: unknown, label: string): CustomProviderInput {
	const obj = guardObject(x, label);
	guardString(obj.name, `${label}.name`);
	guardString(obj.baseUrl, `${label}.baseUrl`);
	if (!Array.isArray(obj.models)) throw new Error(`Invalid ${label}.models: expected array`);
	// Detailed validation deferred to CustomProvidersStore.add/update (assertValid).
	return obj as unknown as CustomProviderInput;
}

/**
 * 校验 MCP Server 配置的基本结构。
 * 详细校验由 MCPManager 内部完成。
 */
export function guardMcpServerConfig(x: unknown, label: string): McpServerConfig {
	const obj = guardObject(x, label);
	guardString(obj.name, `${label}.name`);
	guardEnum(obj.type, `${label}.type`, ["stdio", "http", "sse"] as const);
	if (obj.enabled !== undefined) guardBoolean(obj.enabled, `${label}.enabled`);
	// Detailed validation deferred to MCPManager.
	return obj as unknown as McpServerConfig;
}

/** 校验 Agent 定义输入（Stage 3 广场创建/编辑） */
export function guardAgentDefinitionInput(input: unknown): AgentDefinitionInput {
	const obj = guardObject(input, "input");
	const name = guardString(obj.name, "input.name");
	const description = guardString(obj.description, "input.description");
	const systemPrompt = guardString(obj.systemPrompt, "input.systemPrompt");
	const result: AgentDefinitionInput = { name, description, systemPrompt };
	if (obj.title !== undefined) result.title = guardString(obj.title, "input.title");
	if (obj.model !== undefined) result.model = guardString(obj.model, "input.model");
	if (obj.icon !== undefined) result.icon = guardString(obj.icon, "input.icon");
	if (obj.version !== undefined) result.version = guardString(obj.version, "input.version");
	if (obj.author !== undefined) result.author = guardString(obj.author, "input.author");
	if (obj.tools !== undefined) result.tools = guardStringArray(obj.tools, "input.tools");
	if (obj.tags !== undefined) result.tags = guardStringArray(obj.tags, "input.tags");
	return result;
}
