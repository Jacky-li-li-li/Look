// ============================================================
// MCP Extension — registers tools + slash command via pi SDK
//
// Follows SDK design patterns:
//   - pi.registerTool()  → LLM-autonomous tools (like built-in bash/read)
//   - pi.registerCommand() → user-facing slash command (like /skill:name)
//   - session_start → auto-connect MCP servers (like skills auto-load)
// ============================================================

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { McpManager } from "./mcp-manager.js";

/** Prefix used for all MCP tool names exposed to pi. */
const MCP_TOOL_PREFIX = "mcp:";

/** All active pi instances that need tool updates when MCP servers change. */
const piInstances = new Set<any>();
let listenerRegistered = false;

/**
 * Create an extension factory that:
 * 1. Registers all MCP tools as LLM-callable tools (pi.registerTool)
 * 2. Registers /mcp slash command for discoverability (pi.registerCommand)
 * 3. Auto-connects MCP servers on session_start
 */
export function createMcpExtensionFactory(mcpManager: McpManager): ExtensionFactory {
	return (pi) => {
		piInstances.add(pi);

		// ── 1. Register tools (LLM autonomous) ──
		registerAllTools(pi, mcpManager);

		// Only attach the global listener once.
		if (!listenerRegistered) {
			listenerRegistered = true;
			mcpManager.on("tools:changed", () => {
				for (const p of piInstances) {
					registerAllTools(p, mcpManager);
				}
			});
		}

		// ── 2. Register /mcp slash command (user-facing) ──
		registerMcpCommand(pi, mcpManager);

		// ── 3. Auto-connect on session_start ──
		pi.on("session_start", async () => {
			await mcpManager.connectAll();
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

// ════════════════════════════════════════════════════════════
// /mcp Slash Command (user-facing, like /skill:name)
// ════════════════════════════════════════════════════════════

function registerMcpCommand(pi: any, mcpManager: McpManager): void {
	pi.registerCommand("mcp", {
		description: "List MCP tools or call one directly",
		async handler(rawArgs: string, ctx: any) {
			const args = rawArgs.trim();

			// /mcp (no args) → list all tools
			if (!args) {
				const tools = mcpManager.listAllTools();
				if (tools.length === 0) {
					ctx.ui.notify("No MCP tools available. Add a server in Settings → MCP.", "warning");
					return;
				}
				await listTools(tools, ctx);
				return;
			}

			// /mcp <server> → list tools for that server
			const parts = args.split(/\s+/);
			if (parts.length === 1) {
				const serverName = parts[0];
				const tools = mcpManager.listAllTools().filter((t) => t.serverName === serverName);
				if (tools.length === 0) {
					ctx.ui.notify(`No tools found for server "${serverName}".`, "warning");
					return;
				}
				await listTools(tools, ctx);
				return;
			}

			// /mcp <server> <tool> [json_args] → call tool
			const [serverName, toolName, ...rest] = parts;
			let callArgs: Record<string, unknown> = {};
			if (rest.length > 0) {
				try {
					callArgs = JSON.parse(rest.join(" "));
				} catch {
					ctx.ui.notify(
						'Invalid JSON arguments. Example: /mcp filesystem read_file {"path":"/tmp/test.txt"}',
						"error",
					);
					return;
				}
			}

			const result = await mcpManager.callTool(serverName, toolName, callArgs);
			const text = (result.content || []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
			const prefix = result.isError ? "⚠️ " : "";
			await ctx.ui.editor(`${prefix}${serverName}/${toolName} result`, text || "(empty)");
		},

		getArgumentCompletions(argumentPrefix: string) {
			const tools = mcpManager.listAllTools();
			const prefix = argumentPrefix.toLowerCase();

			// First arg: server names
			if (!prefix.includes(" ")) {
				const servers = [...new Set(tools.map((t) => t.serverName))];
				return servers
					.filter((s) => s.toLowerCase().startsWith(prefix))
					.map((s) => ({ label: s, description: "MCP server" }));
			}

			// Second arg: tool names for the selected server
			const [serverPrefix, ...rest] = prefix.split(/\s+/);
			if (rest.length <= 1) {
				const toolPrefix = rest[0] || "";
				return tools
					.filter(
						(t) => t.serverName === serverPrefix && t.name.toLowerCase().startsWith(toolPrefix.toLowerCase()),
					)
					.map((t) => ({ label: t.name, description: t.description || "MCP tool" }));
			}

			return null;
		},
	});
}

async function listTools(tools: any[], ctx: any): Promise<void> {
	const lines = tools.map(
		(t: any) => `  ${toolPiName(t.serverName, t.name)} — ${t.description || "(no description)"}`,
	);
	await ctx.ui.editor("MCP Tools", lines.join("\n"));
}
