// ============================================================
// MCP router — external MCP server management
// ============================================================

import { guardBoolean, guardMcpServerConfig, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const mcpRouter: IpcRouter = (ctx, register) => {
	const getProjectContext = () => {
		const project = ctx.project.service.getActiveProject();
		return {
			projectId: project?.id ?? "global",
			cwd: project?.cwd,
		};
	};

	register("mcp:list-servers", async () => {
		const { projectId, cwd } = getProjectContext();
		// Only load project-level .look/mcp.json when the project is trusted.
		const loadProjectConfig = cwd ? ctx.project.service.resolveProjectTrust(cwd) : false;
		await ctx.mcp.loadConfig(projectId, cwd, { loadProjectConfig });
		return { success: true, servers: ctx.mcp.getStatusList(projectId) };
	});

	register("mcp:add-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcp.addServer(projectId, guardMcpServerConfig(data.config, "config"), cwd);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:remove-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcp.removeServer(projectId, guardString(data.name, "name"), cwd);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	register("mcp:test-server", async (data) => {
		const { projectId } = getProjectContext();
		const tested = await ctx.mcp.testServer(projectId, guardString(data.name, "name"));
		return tested.success
			? { success: true, tools: tested.tools }
			: { success: false, error: tested.error ?? "test failed" };
	});

	register("mcp:list-tools", async (data) => {
		const { projectId } = getProjectContext();
		const tools = ctx.mcp.getToolsForServer(projectId, guardString(data.name, "name"));
		return { success: true, tools };
	});

	register("mcp:list-all-tools", async () => {
		const { projectId } = getProjectContext();
		return { success: true, tools: ctx.mcp.getAllTools(projectId) };
	});

	register("mcp:toggle-server", async (data) => {
		try {
			const { projectId, cwd } = getProjectContext();
			await ctx.mcp.toggleServer(
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
			await ctx.mcp.updateServer(
				projectId,
				guardString(data.name, "name"),
				guardMcpServerConfig(data.config, "config"),
				cwd,
			);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
};
