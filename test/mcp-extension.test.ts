// ============================================================
// MCP Extension — 集成测试
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { createMcpExtensionFactory } from "../src/main/extensions/mcp-extension.js";
import type { MCPManager } from "../src/main/mcp/manager.js";

/** 创建一个 mock MCPManager */
function createMockMCPManager(overrides: Partial<MCPManager> = {}): MCPManager {
	return {
		loadConfig: vi.fn().mockResolvedValue(undefined),
		startEnabled: vi.fn().mockResolvedValue({ started: ["test-server"], failed: [] }),
		stopAll: vi.fn().mockResolvedValue(undefined),
		getAllTools: vi.fn().mockReturnValue([
			{
				server: "test-server",
				tool: {
					name: "hello",
					description: "Say hello",
					inputSchema: {
						type: "object" as const,
						properties: {
							name: { type: "string", description: "Your name" },
						},
						required: ["name"],
					},
				},
			},
		]),
		executeTool: vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "Hello, World!" }],
			isError: false,
		}),
		getStatusList: vi.fn().mockReturnValue([]),
		addServer: vi.fn().mockResolvedValue(undefined),
		startServer: vi.fn().mockResolvedValue(undefined),
		getToolsForServer: vi.fn().mockReturnValue([]),
		removeServer: vi.fn().mockResolvedValue(undefined),
		toggleServer: vi.fn().mockResolvedValue(undefined),
		updateServer: vi.fn().mockResolvedValue(undefined),
		testServer: vi.fn().mockResolvedValue({ success: true, tools: [] }),
		persistConfig: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as MCPManager;
}

/** 创建一个 mock ExtensionAPI */
function createMockAPI() {
	const tools: Array<{ name: string }> = [];
	const eventHandlers: Record<string, Array<(...args: any[]) => any>> = {};
	const messages: any[] = [];

	return {
		tools,
		eventHandlers,
		messages,
		registerTool: vi.fn((tool: { name: string }) => {
			tools.push(tool);
		}),
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			if (!eventHandlers[event]) eventHandlers[event] = [];
			eventHandlers[event].push(handler);
		}),
		sendMessage: vi.fn((msg: any, opts?: any) => {
			messages.push({ msg, opts });
		}),
	};
}

describe("createMcpExtensionFactory", () => {
	it("registers tools on session_start", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd");
		const api = createMockAPI();

		factory(api as any);

		// trigger session_start
		const handler = api.eventHandlers["session_start"]?.[0];
		expect(handler).toBeDefined();
		await handler!();

		expect(api.registerTool).toHaveBeenCalled();
		expect(api.tools.length).toBe(2);
		expect(api.tools[1].name).toBe("mcp__test-server__hello");
	});

	it("does not stop shared MCP clients on session_shutdown", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd");
		const api = createMockAPI();

		factory(api as any);

		// trigger session_shutdown
		const handler = api.eventHandlers["session_shutdown"]?.[0];
		expect(handler).toBeDefined();
		await handler!();

		expect(mcpManager.stopAll).not.toHaveBeenCalled();
	});

	it("sends warning message when servers fail to start", async () => {
		const mcpManager = createMockMCPManager({
			startEnabled: vi.fn().mockResolvedValue({
				started: [],
				failed: [{ name: "bad-server", error: "Connection refused" }],
			}),
			getAllTools: vi.fn().mockReturnValue([]),
		});
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd");
		const api = createMockAPI();

		factory(api as any);

		const handler = api.eventHandlers["session_start"]?.[0];
		await handler!();

		expect(api.sendMessage).toHaveBeenCalled();
		const call = api.messages[0];
		expect(call.msg.customType).toBe("look.mcp-warning.v1");
		expect(call.msg.content).toContain("bad-server");
	});

	it("executes tool calls via MCPManager", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd");
		const api = createMockAPI();

		factory(api as any);

		// trigger session_start to register tools
		const startHandler = api.eventHandlers["session_start"]?.[0];
		await startHandler!();

		// get the registered tool and call its execute
		const tool = api.registerTool.mock.calls[1]?.[0];
		expect(tool).toBeDefined();

		const result = await tool.execute("call-1", { name: "World" }, undefined);
		expect(mcpManager.executeTool).toHaveBeenCalledWith("test-server", "hello", { name: "World" }, undefined);
		expect(result.content).toBeDefined();
		expect(result.content[0].text).toBe("Hello, World!");
	});
});
