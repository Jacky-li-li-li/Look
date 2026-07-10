// ============================================================
// MCP router — external MCP server management
// ============================================================

import type { McpServerConfig } from "../../mcp/types.js";
import { guardBoolean, guardMcpServerConfig, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const mcpRouter: IpcRouter = (ctx, register) => {
	register("mcp:list-servers", async () => {
		await ctx.mcpManager.loadConfig();
		return { success: true, servers: ctx.mcpManager.getStatusList() };
	});

	register("mcp:add-server", async (data) => {
		try {
			await ctx.mcpManager.addServer(guardMcpServerConfig(data.config, "config") as unknown as McpServerConfig);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:remove-server", async (data) => {
		try {
			await ctx.mcpManager.removeServer(guardString(data.name, "name"));
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:test-server", async (data) => {
		return ctx.mcpManager.testServer(guardString(data.name, "name"));
	});

	register("mcp:list-tools", async (data) => {
		const tools = ctx.mcpManager.getToolsForServer(guardString(data.name, "name"));
		return { success: true, tools };
	});

	register("mcp:list-all-tools", async () => {
		return { success: true, tools: ctx.mcpManager.getAllTools() };
	});

	register("mcp:toggle-server", async (data) => {
		try {
			await ctx.mcpManager.toggleServer(guardString(data.name, "name"), guardBoolean(data.enabled, "enabled"));
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:update-server", async (data) => {
		try {
			await ctx.mcpManager.updateServer(guardString(data.name, "name"), guardMcpServerConfig(data.config, "config") as unknown as McpServerConfig);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
};
