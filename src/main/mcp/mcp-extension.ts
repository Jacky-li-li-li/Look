// ============================================================
// MCP Extension — registers MCP tools through pi's extension API.
//
// Follows SDK design patterns:
//   - pi.registerTool()  → LLM-autonomous tools (like built-in bash/read)
//   - session_start → keep server lifecycle aligned with the active pi session
// ============================================================

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { McpManager } from "./mcp-manager.js";

/** Prefix used for all MCP tool names exposed to pi. */
const MCP_TOOL_PREFIX = "mcp:";

/**
 * Create an extension factory that:
 * 1. Registers all MCP tools as LLM-callable tools (pi.registerTool)
 * 2. Refreshes the active extension registry when server tools change
 * 3. Removes its listener when the pi session shuts down
 */
export function createMcpExtensionFactory(mcpManager: McpManager): ExtensionFactory {
	return (pi) => {
		registerAllTools(pi, mcpManager);
		const refreshTools = () => registerAllTools(pi, mcpManager);
		mcpManager.on("tools:changed", refreshTools);
		pi.on("session_start", async () => {
			await mcpManager.connectAll();
		});
		pi.on("session_shutdown", () => {
			mcpManager.off("tools:changed", refreshTools);
		});
	};
}

// ════════════════════════════════════════════════════════════
// Tool Registration (LLM-callable)
// ════════════════════════════════════════════════════════════

function registerAllTools(pi: any, mcpManager: McpManager): void {
	for (const tool of mcpManager.listAllTools()) {
		registerMcpTool(pi, mcpManager, tool);
	}
}

export function toolPiName(serverName: string, toolName: string): string {
	return `${MCP_TOOL_PREFIX}${serverName}:${toolName}`;
}

function registerMcpTool(pi: any, mcpManager: McpManager, tool: any): void {
	const { name: toolName, description, serverName, inputSchema } = tool;
	const parameters = jsonSchemaToTypeBox(inputSchema);

	pi.registerTool({
		name: toolPiName(serverName, toolName),
		label: `mcp:${serverName}:${toolName}`,
		description: description ? `${description}\n\nServer: ${serverName}` : `MCP tool from "${serverName}".`,
		parameters,
		execute: async (_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined) => {
			const result = await mcpManager.callTool(serverName, toolName, params);
			const text = (result.content || []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
			return {
				content: [{ type: "text", text: text || "(empty result)" }],
				isError: result.isError ?? false,
			};
		},
	});
}

// ════════════════════════════════════════════════════════════
// JSON Schema → TypeBox
// ════════════════════════════════════════════════════════════

/**
 * Convert an MCP tool inputSchema (JSON Schema) into a TypeBox schema.
 *
 * Goals:
 *   - Give the LLM structured parameter guidance.
 *   - Let pi validate tool call arguments before forwarding to MCP.
 *   - Gracefully degrade to Type.Any() for unsupported constructs.
 */
function jsonSchemaToTypeBox(schema: unknown): TSchema {
	if (schema === null || typeof schema !== "object") {
		return Type.Object({}, { additionalProperties: true });
	}

	const s = schema as Record<string, unknown>;

	// Handle enum first, regardless of nominal type.
	if (Array.isArray(s.enum)) {
		const values = s.enum.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
		if (values.length > 0) {
			return Type.Union(
				values.map((v) => Type.Literal(v)),
				{
					description: descriptionFromSchema(s),
				},
			);
		}
	}

	const type = s.type;

	if (type === "object" || (type === undefined && "properties" in s)) {
		const props: Record<string, TSchema> = {};
		const properties = (s.properties as Record<string, unknown>) || {};
		for (const [key, value] of Object.entries(properties)) {
			props[key] = jsonSchemaToTypeBox(value);
		}

		const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
		// Mark optional properties. TypeBox's Type.Object does not accept
		// per-property optionality; we wrap non-required props in Type.Optional.
		for (const key of Object.keys(props)) {
			if (!required.includes(key)) {
				props[key] = Type.Optional(props[key] as TSchema);
			}
		}

		// Respect explicit additionalProperties; default to false for tighter
		// LLM guidance, but allow servers that explicitly opt-in to extras.
		let additionalProperties: boolean | undefined;
		if (s.additionalProperties === true) {
			additionalProperties = true;
		} else if (s.additionalProperties === false) {
			additionalProperties = false;
		} else {
			additionalProperties = false;
		}

		return Type.Object(props, {
			additionalProperties,
			description: descriptionFromSchema(s),
		});
	}

	if (type === "array") {
		const items = jsonSchemaToTypeBox(s.items);
		return Type.Array(items, { description: descriptionFromSchema(s) });
	}

	if (type === "string") {
		const format = typeof s.format === "string" ? s.format : undefined;
		return Type.String({ description: descriptionFromSchema(s), format });
	}

	if (type === "number" || type === "integer") {
		return Type.Number({ description: descriptionFromSchema(s) });
	}

	if (type === "boolean") {
		return Type.Boolean({ description: descriptionFromSchema(s) });
	}

	if (type === "null") {
		return Type.Null({ description: descriptionFromSchema(s) });
	}

	if (Array.isArray(s.type)) {
		// e.g. ["string", "null"]
		const types = s.type.filter((t): t is string => typeof t === "string");
		if (types.length > 0) {
			return Type.Union(
				types.map((t) => jsonSchemaToTypeBox({ ...s, type: t })),
				{ description: descriptionFromSchema(s) },
			);
		}
	}

	// Fallback: accept anything. This keeps exotic schemas functional.
	return Type.Any({ description: descriptionFromSchema(s) });
}

function descriptionFromSchema(schema: Record<string, unknown>): string | undefined {
	return typeof schema.description === "string" ? schema.description : undefined;
}
