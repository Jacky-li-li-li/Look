export type CapabilityKind = "builtin" | "external-mcp" | "unknown";

export interface Capability {
	name: string;
	kind: CapabilityKind;
	description: string;
	requiresExplicitApproval: boolean;
}

const BUILTIN_CAPABILITIES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "web_search"]);

/**
 * The registry is intentionally conservative: integrations not explicitly
 * registered are never silently treated as local capabilities in plan mode.
 */
export class CapabilityRegistry {
	resolve(toolName: string): Capability {
		if (BUILTIN_CAPABILITIES.has(toolName)) {
			return {
				name: toolName,
				kind: "builtin",
				description: `Built-in capability: ${toolName}`,
				requiresExplicitApproval: false,
			};
		}
		if (toolName.startsWith("mcp__")) {
			return {
				name: toolName,
				kind: "external-mcp",
				description: `External MCP capability: ${toolName}`,
				requiresExplicitApproval: true,
			};
		}
		return {
			name: toolName,
			kind: "unknown",
			description: `Unknown capability: ${toolName}`,
			requiresExplicitApproval: true,
		};
	}
}

export const defaultCapabilityRegistry = new CapabilityRegistry();
