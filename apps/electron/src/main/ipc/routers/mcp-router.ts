// ============================================================
// MCP router — external MCP server management
// ============================================================

import type { McpServerConfig } from "../../mcp/types.js";
import { guardBoolean, guardMcpServerConfig, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const mcpRouter: IpcRouter = (ctx, register) => {
	const getProjectContext = () => {
		const project = ctx.runtimeManager.getActiveProject();
		return {
			projectId: project?.id ?? "global",
			cwd: project?.cwd,
		};
	};

	register("mcp:list-servers", async () => {
		const { projectId, cwd } = getProjectContext();
		await ctx.mcpManager.loadConfig(projectId, cwd);
		return { success: true, servers: ctx.mcpManager.getStatusList(projectId) };
	});

	register("mcp:add-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcpManager.addServer(
				projectId,
				guardMcpServerConfig(data.config, "config") as unknown as McpServerConfig,
				cwd,
			);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:remove-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcpManager.removeServer(projectId, guardString(data.name, "name"), cwd);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:test-server", async (data) => {
		const { projectId } = getProjectContext();
		return ctx.mcpManager.testServer(projectId, guardString(data.name, "name"));
	});

	register("mcp:list-tools", async (data) => {
		const { projectId } = getProjectContext();
		const tools = ctx.mcpManager.getToolsForServer(projectId, guardString(data.name, "name"));
		return { success: true, tools };
	});

	register("mcp:list-all-tools", async () => {
		const { projectId } = getProjectContext();
		return { success: true, tools: ctx.mcpManager.getAllTools(projectId) };
	});

	register("mcp:toggle-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcpManager.toggleServer(
				projectId,
				guardString(data.name, "name"),
				guardBoolean(data.enabled, "enabled"),
				cwd,
			);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:update-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcpManager.updateServer(
				projectId,
				guardString(data.name, "name"),
				guardMcpServerConfig(data.config, "config") as unknown as McpServerConfig,
				cwd,
			);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
};
