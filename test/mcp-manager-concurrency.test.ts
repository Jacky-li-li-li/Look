import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	listTools: vi.fn(async () => ({ tools: [] })),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = mocks.connect;
		close = mocks.close;
		listTools = mocks.listTools;
		callTool = vi.fn(async () => ({ content: [] }));
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class {
		constructor(_options: unknown) {}
	},
}));

import { McpManager } from "../src/main/mcp/mcp-manager";

describe("McpManager connection lifecycle", () => {
	beforeEach(() => vi.clearAllMocks());

	it("deduplicates concurrent and repeated connections with the same config", async () => {
		const manager = new McpManager();
		const config = { command: "example", args: ["serve"] };
		await Promise.all([manager.connectServer("demo", config), manager.connectServer("demo", config)]);
		await manager.connectServer("demo", config);
		expect(mocks.connect).toHaveBeenCalledTimes(1);
		expect(mocks.close).not.toHaveBeenCalled();
	});

	it("reconnects only when the server config changes", async () => {
		const manager = new McpManager();
		await manager.connectServer("demo", { command: "one" });
		await manager.connectServer("demo", { command: "two" });
		expect(mocks.connect).toHaveBeenCalledTimes(2);
		expect(mocks.close).toHaveBeenCalledTimes(1);
	});
});
