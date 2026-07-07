// ============================================================
// MCP Extension — pi SDK ExtensionFactory
//
// 在 session 启动时连接所有启用的 MCP 服务器，将它们的工具
// 桥接注册到 pi SDK。同时注册 mcp_connect 工具供 AI 调用。
// 与 Permission / Plan / SubAgent 扩展并列注入。
// ============================================================

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MCPManager } from "../mcp/manager.js";
import { jsonSchemaToTypeBox } from "../mcp/schema-convert.js";
import type { McpCallResult } from "../mcp/types.js";

const McpConnectParams = Type.Object({
	name: Type.String({ description: "A short name for this MCP server (e.g. filesystem, github)" }),
	command: Type.String({ description: 'The command to run, usually npx or uvx (e.g. "npx")' }),
	args: Type.String({
		description:
			'Arguments passed to the command, space-separated (e.g. "-y @modelcontextprotocol/server-filesystem /path")',
	}),
});

/**
 * 创建 MCP Extension 工厂函数。
 * 注入点：SessionRuntimeManager.buildExtensionFactories()。
 */
export function createMcpExtensionFactory(sessionId: string, mcpManager: MCPManager, cwd: string): ExtensionFactory {
	return (api) => {
		const registeredToolNames = new Set<string>();
		const registerConnectedMcpTools = () => {
			for (const { server, tool } of mcpManager.getAllTools()) {
				const toolName = `mcp__${server}__${tool.name}`;
				if (registeredToolNames.has(toolName)) continue;

				try {
					api.registerTool({
						name: toolName,
						label: `${server}/${tool.name}`,
						description: tool.description
							? `[MCP:${server}] ${tool.description}`
							: `MCP tool "${tool.name}" from server "${server}"`,
						parameters: jsonSchemaToTypeBox(tool.inputSchema),
						executionMode: "sequential",

						async execute(_toolCallId, params, signal) {
							if (signal?.aborted) {
								return {
									content: [{ type: "text" as const, text: "Tool call was aborted." }],
									details: { server, tool: tool.name, aborted: true },
								};
							}

							const result: McpCallResult = await mcpManager.executeTool(
								server,
								tool.name,
								params as Record<string, unknown>,
								signal,
							);

							return normalizeResult(result, server, tool.name);
						},
					});
					registeredToolNames.add(toolName);
				} catch (error) {
					// 单个工具注册失败不阻塞其他工具
					console.warn(`[Look][MCP] Failed to register tool "${toolName}":`, error);
				}
			}
		};

		// ── mcp_connect 工具 —— AI 可调用来自动配置 MCP 服务器 ──
		api.registerTool<typeof McpConnectParams, Record<string, unknown>>({
			name: "mcp_connect",
			label: "Connect MCP server",
			description:
				"Add and connect a new MCP (Model Context Protocol) stdio server. " +
				"Use this when the user wants to connect an external MCP server. " +
				"After connecting, the server's tools become available as mcp__<name>__<tool>.",
			promptSnippet: "Connect an external MCP server to extend available tools",
			parameters: McpConnectParams,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				try {
					await mcpManager.addServer({
						name: params.name,
						type: "stdio",
						command: params.command,
						args: shellSplitArgs(params.args),
						enabled: true,
					});
					await mcpManager.startServer(params.name);
					registerConnectedMcpTools();

					return {
						content: [
							{
								type: "text",
								text: `MCP server "${params.name}" added and connected. Registered ${mcpManager.getToolsForServer(params.name).length} tool(s).`,
							},
						],
						details: { server: params.name },
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to connect "${params.name}": ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { server: params.name, error: error instanceof Error ? error.message : String(error) },
					};
				}
			},
		});

		// ── session_start —— 启动所有已配置的 MCP 服务器 ──
		api.on("session_start", async () => {
			await mcpManager.loadConfig(cwd);
			const { started, failed } = await mcpManager.startEnabled();

			// 注册所有 MCP 工具到 pi SDK
			registerConnectedMcpTools();

			// 注入启动失败警告
			if (failed.length > 0) {
				const failedNames = failed.map((f) => `${f.name} (${f.error})`).join(", ");
				api.sendMessage(
					{
						customType: "look.mcp-warning.v1",
						content: `MCP servers failed to start: ${failedNames}. ` + `Started: ${started.length} server(s).`,
						display: false,
					},
					{ deliverAs: "followUp" },
				);
			}
		});

		// MCPManager is shared across live sessions. Do not stop all clients when
		// one runtime shuts down; app-level disposal owns process cleanup.
		api.on("session_shutdown", async () => {
			void sessionId;
		});
	};
}

/** 将 MCP 调用结果转换为 pi SDK 的 AgentToolResult 格式 */
/** 将命令行字符串按 shell 引号规则分割，支持单引号、双引号和反斜杠转义。 */
function shellSplitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let hasToken = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
				hasToken = true;
			}
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && i + 1 < input.length) {
				// 双引号内反斜杠转义下一个字符
				i++;
				current += input[i];
				hasToken = true;
			} else {
				current += ch;
				hasToken = true;
			}
		} else if (ch === "'") {
			inSingle = true;
			hasToken = true;
		} else if (ch === '"') {
			inDouble = true;
			hasToken = true;
		} else if (ch === "\\" && i + 1 < input.length) {
			// 非引号内的反斜杠转义下一个字符
			i++;
			current += input[i];
			hasToken = true;
		} else if (ch === " " || ch === "\t") {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += ch;
			hasToken = true;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

function normalizeResult(
	result: McpCallResult,
	_server: string,
	_tool: string,
): {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: unknown;
} {
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

	for (const item of result.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			content.push({ type: "text" as const, text: item.text });
		} else if (item.type === "image" && typeof item.data === "string") {
			content.push({
				type: "image" as const,
				data: item.data,
				mimeType: item.mimeType ?? "image/png",
			});
		}
	}

	if (content.length === 0) {
		content.push({ type: "text", text: JSON.stringify(result) });
	}

	return {
		content,
		details: { isError: result.isError ?? false },
	};
}
