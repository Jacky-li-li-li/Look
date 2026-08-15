export type CapabilityKind = "builtin" | "computer-use" | "external-mcp" | "unknown";

export interface Capability {
	name: string;
	kind: CapabilityKind;
	description: string;
	requiresExplicitApproval: boolean;
}

const BUILTIN_CAPABILITIES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "web_search"]);

/**
 * 内置 computer_* 工具（computer-use-extension 注册）。
 * requiresExplicitApproval 与 tool-permission-registry 的声明一致：
 * 有副作用的输入工具（click/type/key）需要确认；截图/移动/滚动是
 * 低风险观察操作。该字段只在工具被拦截时生效（plan 模式阻断、
 * ask 模式弹确认），这里同时提供面向用户的描述文案。
 */
const COMPUTER_USE_CAPABILITIES = new Map<string, { description: string; requiresExplicitApproval: boolean }>([
	[
		"computer_screenshot",
		{ description: "Computer use: capture the primary display", requiresExplicitApproval: false },
	],
	["computer_mouse_move", { description: "Computer use: move the mouse pointer", requiresExplicitApproval: false }],
	["computer_scroll", { description: "Computer use: scroll the view", requiresExplicitApproval: false }],
	["computer_click", { description: "Computer use: click a mouse button", requiresExplicitApproval: true }],
	["computer_type", { description: "Computer use: type text", requiresExplicitApproval: true }],
	["computer_key", { description: "Computer use: press a key or shortcut", requiresExplicitApproval: true }],
]);

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
		const computer = COMPUTER_USE_CAPABILITIES.get(toolName);
		if (computer) {
			return {
				name: toolName,
				kind: "computer-use",
				description: computer.description,
				requiresExplicitApproval: computer.requiresExplicitApproval,
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
