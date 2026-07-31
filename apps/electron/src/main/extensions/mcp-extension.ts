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
import { declareApprovalRequiredTool } from "./tool-permission-registry.js";

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
export function createMcpExtensionFactory(
	sessionId: string,
	mcpManager: MCPManager,
	cwd: string,
	projectId: string,
	resolveProjectTrust?: (cwd: string) => boolean,
): ExtensionFactory {
	return (api) => {
		const registeredToolNames = new Set<string>();
		const registerConnectedMcpTools = () => {
			for (const { server, tool } of mcpManager.getAllTools(projectId)) {
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
								projectId,
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
		// 声明式权限：mcp_connect 会 spawn 任意 stdio 进程（npx/uvx/...），
		// 必须在 ask/plan 模式走权限拦截。声明后 permission-extension 自动拦截。
		declareApprovalRequiredTool("mcp_connect");
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
				await mcpManager.addServer(
					projectId,
					{
						name: params.name,
						type: "stdio",
						command: params.command,
						args: shellSplitArgs(params.args),
						enabled: true,
					},
					cwd,
				);
				await mcpManager.startServer(projectId, params.name);
				registerConnectedMcpTools();

				return {
					content: [
						{
							type: "text",
							text: `MCP server "${params.name}" added and connected. Registered ${mcpManager.getToolsForServer(projectId, params.name).length} tool(s).`,
						},
					],
					details: { server: params.name },
				};
			},
		});

		// ── session_start —— 启动所有已配置的 MCP 服务器 ──
		api.on("session_start", async () => {
			// Gate project-level .look/mcp.json behind project trust. pi's own
			// trust check only covers .pi/* — without this gate, an untrusted
			// project's .look/mcp.json would still be loaded and spawned.
			const loadProjectConfig = resolveProjectTrust?.(cwd) ?? true;
			await mcpManager.loadConfig(projectId, cwd, { loadProjectConfig });
			const { started, failed } = await mcpManager.startEnabled(projectId);

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

/** 将命令行字符串按 shell 引号规则分割，支持单引号、双引号和反斜杠转义。
 *  拒绝 $()、反引号等 shell 扩展语法，防止命令注入。 */
function shellSplitArgs(input: string): string[] {
	// 拒绝 shell 命令替换和扩展语法
	if (/\$\(|`|\$\(\(/.test(input)) {
		throw new Error("MCP args must not contain shell expansions ($(), backticks, $(()))");
	}
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
	if (result.isError) {
		const text = (result.content ?? [])
			.filter(
				(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
			)
			.map((item) => item.text)
			.join("\n");
		throw new Error(text || "MCP tool call failed");
	}

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
		details: { isError: false },
	};
}
