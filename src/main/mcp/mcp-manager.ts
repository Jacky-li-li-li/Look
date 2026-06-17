// ============================================================
// McpManager — MCP server lifecycle & tool discovery
// ============================================================

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getMcpServersPath } from "../shared/look-storage.js";

// ── Types ──

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerInfo {
	name: string;
	config: McpServerConfig;
	status: McpServerStatus;
	error?: string;
	toolCount: number;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	serverName: string;
}

export interface McpServersConfig {
	servers: Record<string, McpServerConfig>;
}

// ── Connected server state ──

interface ConnectedServer {
	client: Client;
	transport: StdioClientTransport;
	tools: McpToolInfo[];
}

// ── Manager ──

export class McpManager extends EventEmitter {
	private servers: Map<string, ConnectedServer> = new Map();
	/** Track intermediate state for servers that are connecting or errored (not yet/already in `servers`). */
	private pending: Map<string, { status: "connecting"; error?: string } | { status: "error"; error: string }> =
		new Map();
	private configPath: string;

	constructor() {
		super();
		this.configPath = getMcpServersPath();
	}

	// ── Config I/O ──

	loadConfig(): McpServersConfig {
		try {
			if (!fs.existsSync(this.configPath)) {
				return { servers: {} };
			}
			const raw = fs.readFileSync(this.configPath, "utf-8");
			return JSON.parse(raw) as McpServersConfig;
		} catch {
			return { servers: {} };
		}
	}

	saveConfig(config: McpServersConfig): void {
		const dir = path.dirname(this.configPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
	}

	// ── Connection management ──

	async connectAll(): Promise<void> {
		const config = this.loadConfig();
		const entries = Object.entries(config.servers);
		// Connect in parallel — each server is independent
		await Promise.all(entries.map(([name, serverConfig]) => this.connectServer(name, serverConfig)));
	}

	async connectServer(name: string, config: McpServerConfig): Promise<void> {
		if (this.servers.has(name)) {
			await this.disconnectServer(name);
		}

		this.pending.set(name, { status: "connecting" });
		this.emit("server:status", { name, status: "connecting" as McpServerStatus });

		try {
			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env,
			});

			const client = new Client({ name: "look", version: "1.0.0" }, { capabilities: {} });

			await client.connect(transport);

			const result = await client.listTools();
			const tools: McpToolInfo[] = (result.tools || []).map((t: any) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema || {},
				serverName: name,
			}));

			this.servers.set(name, { client, transport, tools });
			this.pending.delete(name);

			this.emit("server:status", {
				name,
				status: "connected" as McpServerStatus,
				toolCount: tools.length,
			});
			this.emit("tools:changed", this.listAllTools());
		} catch (err: any) {
			this.pending.set(name, { status: "error", error: err?.message ?? String(err) });
			this.emit("server:status", {
				name,
				status: "error" as McpServerStatus,
				error: err?.message ?? String(err),
			});
		}
	}

	async disconnectServer(name: string): Promise<void> {
		const s = this.servers.get(name);
		if (s) {
			try {
				await s.client.close();
			} catch {
				// best-effort
			}
		}

		this.servers.delete(name);
		this.pending.delete(name);
		this.emit("server:status", {
			name,
			status: "disconnected" as McpServerStatus,
			toolCount: 0,
		});
		this.emit("tools:changed", this.listAllTools());
	}

	async disconnectAll(): Promise<void> {
		const names = [...this.servers.keys()];
		await Promise.all(names.map((name) => this.disconnectServer(name)));
		this.pending.clear();
	}

	async restartServer(name: string): Promise<void> {
		const config = this.loadConfig();
		const serverConfig = config.servers[name];
		if (!serverConfig) return;

		await this.disconnectServer(name);
		await this.connectServer(name, serverConfig);
	}

	// ── Server config CRUD ──

	async addServer(name: string, config: McpServerConfig): Promise<void> {
		const cfg = this.loadConfig();
		cfg.servers[name] = config;
		this.saveConfig(cfg);
		await this.connectServer(name, config);
	}

	async removeServer(name: string): Promise<void> {
		const cfg = this.loadConfig();
		delete cfg.servers[name];
		this.saveConfig(cfg);
		await this.disconnectServer(name);
	}

	// ── Tool methods ──

	listAllTools(): McpToolInfo[] {
		const all: McpToolInfo[] = [];
		for (const [name, s] of this.servers) {
			for (const t of s.tools) {
				all.push({ ...t, serverName: name });
			}
		}
		return all;
	}

	getServerStatuses(): McpServerInfo[] {
		const config = this.loadConfig();
		const result: McpServerInfo[] = [];

		for (const [name, serverConfig] of Object.entries(config.servers)) {
			const connected = this.servers.get(name);
			const pending = this.pending.get(name);

			let status: McpServerStatus = "disconnected";
			let error: string | undefined;

			if (connected) {
				status = "connected";
			} else if (pending) {
				status = pending.status;
				error = pending.error;
			}

			result.push({
				name,
				config: serverConfig,
				status,
				error,
				toolCount: connected?.tools.length ?? 0,
			});
		}

		return result;
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
		const s = this.servers.get(serverName);
		if (!s) {
			return {
				content: [{ type: "text", text: `MCP server "${serverName}" is not connected.` }],
				isError: true,
			};
		}

		try {
			const result = await s.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 120_000 });
			return result as any;
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `MCP tool error: ${err?.message ?? String(err)}` }],
				isError: true,
			};
		}
	}
}
