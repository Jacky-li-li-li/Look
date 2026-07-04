// ============================================================
// MCP 客户端
//
// 单个 MCP 服务器的客户端，管理完整的连接生命周期：
// connect → initialize → tools/list → [tools/call...] → disconnect
// ============================================================

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpCallResult, McpServerConfig, McpTool } from "./types.js";

/** 客户端状态 */
type ClientState = "disconnected" | "connecting" | "connected";

export class McpClient {
	readonly name: string;
	private config: McpServerConfig;
	private client: Client | null = null;
	private transport: Transport | null = null;
	private tools: McpTool[] = [];
	private state: ClientState = "disconnected";

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	// ── 连接 ──

	async connect(): Promise<void> {
		if (this.state === "connecting" || this.state === "connected") return;

		this.state = "connecting";

		try {
			this.transport = createTransport(this.config);

			this.client = new Client({ name: "look", version: "1.0.0" }, { capabilities: {} });

			await this.client.connect(this.transport);

			const result = await this.client.listTools();
			this.tools = (result.tools ?? []) as McpTool[];

			this.state = "connected";
		} catch (error) {
			this.state = "disconnected";
			try {
				await this.client?.close();
			} catch {
				/* ignore cleanup errors */
			}
			this.client = null;
			this.transport = null;
			throw error;
		}
	}

	// ── 工具调用 ──

	getTools(): McpTool[] {
		return this.tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		if (!this.client || this.state !== "connected") {
			throw new Error(`MCP server "${this.name}" is not connected`);
		}

		const timeout = this.config.timeout ?? 120_000;
		const result = await this.withTimeout(
			this.client.callTool({ name, arguments: args }),
			timeout,
			`Tool "${name}" timed out after ${timeout}ms`,
		);

		return result as McpCallResult;
	}

	// ── 断开 ──

	async disconnect(): Promise<void> {
		this.state = "disconnected";

		if (this.client) {
			try {
				await this.client.close();
			} catch {
				// 忽略关闭错误
			}
			this.client = null;
		}

		this.transport = null;
		this.tools = [];
	}

	// ── 状态查询 ──

	get isConnected(): boolean {
		return this.state === "connected";
	}

	// ── 辅助 ──

	private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function createTransport(config: McpServerConfig): Transport {
	switch (config.type) {
		case "stdio": {
			if (!config.command) throw new Error("stdio MCP server requires a command");
			return new StdioClientTransport({
				command: config.command,
				args: config.args ?? [],
				env: config.env as Record<string, string> | undefined,
			});
		}
		case "http": {
			if (!config.url) throw new Error("HTTP MCP server requires a URL");
			return new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: config.headers ? { headers: config.headers } : undefined,
			});
		}
		case "sse": {
			if (!config.url) throw new Error("SSE MCP server requires a URL");
			return new SSEClientTransport(new URL(config.url), {
				requestInit: config.headers ? { headers: config.headers } : undefined,
				eventSourceInit: config.headers
					? { fetch: (input, init) => fetch(input, withHeaders(init, config.headers)) }
					: undefined,
			});
		}
		default:
			throw new Error(`Unsupported MCP transport: ${(config as McpServerConfig).type}`);
	}
}

function withHeaders(init: RequestInit | undefined, headers: Record<string, string> | undefined): RequestInit {
	if (!headers) return init ?? {};
	return {
		...(init ?? {}),
		headers: {
			...(init?.headers as Record<string, string> | undefined),
			...headers,
		},
	};
}
