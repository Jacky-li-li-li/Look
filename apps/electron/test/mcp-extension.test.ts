// ============================================================
// MCP Extension — 集成测试
// ============================================================

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMcpExtensionFactory } from "../src/main/extensions/mcp-extension.js";
import type { MCPManager } from "../src/main/mcp/manager.js";

const TEST_PROJECT_ID = "test-project";

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
	} as MCPManager;
}

// Tool helper — matches the ToolDefinition.execute signature for tool tests
type ToolExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined,
	ctx: Record<string, unknown>,
) => Promise<AgentToolResult<unknown>>;

interface MockTool {
	name: string;
	execute: ToolExecute;
}

interface MockAPI {
	tools: MockTool[];
	eventHandlers: Record<string, Array<(...args: unknown[]) => unknown>>;
	messages: Array<{ msg: Record<string, unknown>; opts?: unknown }>;
	registerTool: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
}

/** 创建一个 mock ExtensionAPI */
function createMockAPI(): MockAPI {
	const tools: MockTool[] = [];
	const eventHandlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
	const messages: Array<{ msg: Record<string, unknown>; opts?: unknown }> = [];

	return {
		tools,
		eventHandlers,
		messages,
		registerTool: vi.fn((tool: { name: string; execute: ToolExecute }) => {
			tools.push(tool as MockTool);
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (!eventHandlers[event]) eventHandlers[event] = [];
			eventHandlers[event].push(handler);
		}),
		sendMessage: vi.fn((msg: Record<string, unknown>, opts?: unknown) => {
			messages.push({ msg, opts });
		}),
	} as MockAPI;
}

async function triggerSessionStart(api: MockAPI): Promise<void> {
	const handler = api.eventHandlers.session_start?.[0];
	expect(handler).toBeDefined();
	await handler!();
}

describe("createMcpExtensionFactory", () => {
	it("registers tools on session_start", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		await triggerSessionStart(api);

		expect(mcpManager.loadConfig).toHaveBeenCalledWith(TEST_PROJECT_ID, "/test/cwd");
		expect(mcpManager.startEnabled).toHaveBeenCalledWith(TEST_PROJECT_ID);
		expect(api.registerTool).toHaveBeenCalled();
		expect(api.tools.length).toBe(2);
		expect(api.tools[1].name).toBe("mcp__test-server__hello");
	});

	it("does not stop shared MCP clients on session_shutdown", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		const handler = api.eventHandlers.session_shutdown?.[0];
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
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		await triggerSessionStart(api);

		expect(api.sendMessage).toHaveBeenCalled();
		const call = api.messages[0];
		expect(call.msg.customType).toBe("look.mcp-warning.v1");
		expect(call.msg.content).toContain("bad-server");
	});

	it("executes tool calls via MCPManager", async () => {
		const mcpManager = createMockMCPManager();
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		await triggerSessionStart(api);

		const tool = api.registerTool.mock.calls[1]?.[0] as MockTool | undefined;
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-1", { name: "World" }, undefined, undefined, {});
		expect(mcpManager.executeTool).toHaveBeenCalledWith(
			TEST_PROJECT_ID,
			"test-server",
			"hello",
			{ name: "World" },
			undefined,
		);
		expect(result.content[0]).toMatchObject({ text: "Hello, World!" });
	});

	it("throws when executeTool result has isError", async () => {
		const mcpManager = createMockMCPManager({
			executeTool: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Something went wrong" }],
				isError: true,
			}),
		});
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		await triggerSessionStart(api);

		const tool = api.registerTool.mock.calls[1]?.[0] as MockTool | undefined;
		expect(tool).toBeDefined();

		await expect(tool!.execute("call-1", { name: "World" }, undefined, undefined, {})).rejects.toThrow(
			"Something went wrong",
		);
	});

	it("throws when mcp_connect fails", async () => {
		const mcpManager = createMockMCPManager({
			addServer: vi.fn().mockRejectedValue(new Error("add failed")),
		});
		const factory = createMcpExtensionFactory("test-session", mcpManager, "/test/cwd", TEST_PROJECT_ID);
		const api = createMockAPI();
		factory(api as unknown as ExtensionAPI);

		await triggerSessionStart(api);

		const connectTool = api.tools.find((t) => t.name === "mcp_connect");
		expect(connectTool).toBeDefined();

		const result = connectTool!.execute(
			"call-1",
			{
				name: "new-server",
				command: "npx",
				args: "-y @modelcontextprotocol/server-filesystem /tmp",
			},
			undefined,
			undefined,
			{},
		);
		await expect(result).rejects.toThrow("add failed");
	});
});
