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

/**
 * 连接预算（Proma 式）：默认 30s 建连，覆盖 stdio 冷启动（npx 大包 /
 * docker 类进程）与真实网络；连接已在后台进行（session_start 即启动、
 * 项目激活预热），预算宽裕不会拖慢任何用户路径，误判为病态的概率更低。
 * 用户显式配置的 timeout 永远优先（同时作用于连接与工具调用）。
 */
export function defaultConnectTimeoutMs(_type: McpServerConfig["type"] | undefined): number {
	return 30_000;
}

export class McpClient {
	readonly name: string;
	private config: McpServerConfig;
	private client: Client | null = null;
	private transport: Transport | null = null;
	private tools: McpTool[] = [];
	private state: ClientState = "disconnected";
	/** 最近一次工具调用时间（空闲回收判定）。 */
	private lastUsedAt: number = Date.now();

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	/** 工具调用时刷新活跃时间。 */
	touch(): void {
		this.lastUsedAt = Date.now();
	}

	/** 距最近一次工具调用的空闲毫秒数。 */
	idleMs(now = Date.now()): number {
		return now - this.lastUsedAt;
	}

	// ── 连接 ──

	async connect(): Promise<void> {
		if (this.state === "connecting" || this.state === "connected") return;

		this.state = "connecting";

		try {
			this.transport = createTransport(this.config);

			this.client = new Client({ name: "look", version: "1.0.0" }, { capabilities: {} });

			const connectTimeout = this.config.timeout ?? defaultConnectTimeoutMs(this.config.type);
			await this.withTimeout(
				this.client.connect(this.transport),
				connectTimeout,
				`MCP server "${this.name}" connection timed out after ${connectTimeout}ms`,
			);

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

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		if (!this.client || this.state !== "connected") {
			throw new Error(`MCP server "${this.name}" is not connected`);
		}

		this.touch();
		const timeout = this.config.timeout ?? 120_000;
		const result = await this.withTimeout(
			this.client.callTool({ name, arguments: args }),
			timeout,
			`Tool "${name}" timed out after ${timeout}ms`,
			signal,
		);

		return result as McpCallResult;
	}

	// ── 断开 ──

	async disconnect(): Promise<void> {
		if (this.state === "disconnected") return;
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

	private async withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		});
		try {
			if (signal) {
				if (signal.aborted) throw signal.reason ?? new Error("Aborted");
				let onAbort: (() => void) | undefined;
				const abortPromise = new Promise<never>((_, reject) => {
					onAbort = () => reject(signal.reason ?? new Error("Aborted"));
					signal.addEventListener("abort", onAbort, { once: true });
				});
				try {
					return await Promise.race([promise, timeout, abortPromise]);
				} finally {
					if (onAbort) signal.removeEventListener("abort", onAbort);
				}
			}
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
