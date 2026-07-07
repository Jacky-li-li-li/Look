// ============================================================
// MCP Manager
//
// 管理所有 MCP 客户端的生命周期：配置加载、启动、停止、
// 工具聚合、状态查询、熔断保护。
// ============================================================

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { McpClient } from "./client.js";
import type { McpCallResult, McpServerConfig, McpServerStatus, McpTestResult, McpTool } from "./types.js";

/** 熔断器状态 */
interface CircuitState {
	failures: number;
	openUntil: number;
}

export class MCPManager {
	private clients = new Map<string, McpClient>();
	private configs = new Map<string, McpServerConfig>();
	private clientStarts = new Map<string, Promise<McpClient>>();
	private lastErrors = new Map<string, string>();
	private circuitStates = new Map<string, CircuitState>();
	private readonly failureThreshold = 5;
	private readonly circuitOpenMs = 30_000;
	private onChange: (() => void) | null = null;

	/** 注册变更回调 — 当服务器列表变化时通知渲染进程。 */
	setOnChange(cb: () => void): void {
		this.onChange = cb;
	}

	private notifyChange(): void {
		this.onChange?.();
	}

	// ── 配置加载 ──

	/**
	 * 加载并合并 MCP 服务器配置。
	 * 优先级：用户级 > 项目级 > 自动发现
	 */
	async loadConfig(cwd?: string): Promise<void> {
		const merged = new Map<string, McpServerConfig>();

		// 1. 自动发现兼容配置（优先级最低）
		for (const config of await discoverCompatibleConfigs(cwd)) {
			merged.set(config.name, { ...config, _source: "discovered" });
		}

		// 2. 项目级配置（如果 cwd 提供）
		if (cwd) {
			const projectConfigPath = path.join(cwd, ".look", "mcp.json");
			for (const config of await loadConfigFile(projectConfigPath)) {
				merged.set(config.name, { ...config, _source: "project" });
			}
		}

		// 3. 用户级配置（优先级最高）
		const userConfigPath = path.join(homedir(), ".look", "mcp.json");
		for (const config of await loadConfigFile(userConfigPath)) {
			merged.set(config.name, { ...config, _source: "user" });
		}

		const previous = this.configs;
		const changed = !configMapsEqual(previous, merged);
		this.configs = merged;

		// 清理已从配置中移除、禁用或连接参数变化的客户端连接。
		for (const [name, client] of this.clients) {
			const nextConfig = merged.get(name);
			if (!nextConfig?.enabled || !mcpConfigEqual(previous.get(name), nextConfig)) {
				await client.disconnect();
				this.clients.delete(name);
			}
		}
		if (changed) this.notifyChange();
	}

	/**
	 * 持久化用户级配置到 ~/.look/mcp.json。
	 * 只持久化 _source === "user" 的配置。
	 */
	async persistConfig(): Promise<void> {
		const { writeFile, mkdir } = await import("node:fs/promises");
		const lookDir = path.join(homedir(), ".look");
		const configPath = path.join(lookDir, "mcp.json");

		await mkdir(lookDir, { recursive: true });

		const servers: Record<string, unknown> = {};
		for (const [, config] of this.configs) {
			if (config._source !== "user") continue;
			const {
				name: _name,
				_source: _src,
				_discoveredFrom: _disc,
				...rest
			} = config as unknown as Record<string, unknown>;
			servers[config.name] = rest;
		}

		await writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
	}

	// ── 生命周期 ──

	/**
	 * 并行启动所有已启用的服务器。
	 * 单个服务器启动失败不影响其他服务器。
	 */
	async startEnabled(): Promise<{
		started: string[];
		failed: Array<{ name: string; error: string }>;
	}> {
		const started: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		const tasks = Array.from(this.configs.values())
			.filter((c) => c.enabled)
			.map(async (config) => {
				try {
					await this.startServer(config.name);
					started.push(config.name);
				} catch (error) {
					failed.push({
						name: config.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});

		await Promise.allSettled(tasks);
		return { started, failed };
	}

	/** 启动单个服务器。并发调用会复用同一个 in-flight connect。 */
	async startServer(name: string): Promise<McpClient> {
		const config = this.configs.get(name);
		if (!config) throw new Error(`MCP server "${name}" not found`);
		if (!config.enabled) throw new Error(`MCP server "${name}" is disabled`);

		const existing = this.clients.get(name);
		if (existing?.isConnected) return existing;

		const pending = this.clientStarts.get(name);
		if (pending) return pending;

		const start = (async () => {
			const stale = this.clients.get(name);
			if (stale) {
				await stale.disconnect();
				this.clients.delete(name);
			}

			const client = new McpClient(name, config);
			this.clients.set(name, client);
			this.lastErrors.delete(name);
			this.notifyChange();

			try {
				await client.connect();
				if (this.clients.get(name) !== client || !this.configs.get(name)?.enabled) {
					await client.disconnect();
					throw new Error(`MCP server "${name}" start was cancelled`);
				}
				this.lastErrors.delete(name);
				return client;
			} catch (error) {
				if (this.clients.get(name) === client) this.clients.delete(name);
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("start was cancelled")) this.lastErrors.set(name, message);
				throw error;
			} finally {
				this.clientStarts.delete(name);
				this.notifyChange();
			}
		})();

		this.clientStarts.set(name, start);
		return start;
	}

	/** 断开所有连接 */
	async stopAll(): Promise<void> {
		const tasks = Array.from(this.clients.values()).map((c) => c.disconnect());
		await Promise.allSettled(tasks);
		this.clients.clear();
		this.clientStarts.clear();
		this.circuitStates.clear();
		this.lastErrors.clear();
	}

	// ── 工具操作 ──

	/** 聚合所有已连接服务器的工具列表 */

	/** 获取单个服务器的工具列表 */
	getToolsForServer(name: string): McpTool[] {
		const client = this.clients.get(name);
		return client?.getTools() ?? [];
	}

	getAllTools(): Array<{ server: string; tool: McpTool }> {
		const result: Array<{ server: string; tool: McpTool }> = [];
		for (const [serverName, client] of this.clients) {
			if (!client.isConnected) continue;
			for (const tool of client.getTools()) {
				result.push({ server: serverName, tool });
			}
		}
		return result;
	}

	/**
	 * 执行 MCP 工具调用，带熔断保护。
	 * 30s 窗口内 5 次失败 → 断路 30s。
	 */
	async executeTool(server: string, tool: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		// 熔断器检查
		const circuit = this.circuitStates.get(server);
		if (circuit && circuit.failures >= this.failureThreshold) {
			if (Date.now() < circuit.openUntil) {
				throw new Error(
					`MCP server "${server}" circuit breaker is open. ` +
						`Retry after ${new Date(circuit.openUntil).toLocaleTimeString()}`,
				);
			}
			// 半开状态：允许一次尝试
			this.circuitStates.delete(server);
		}

		const client = this.clients.get(server);
		if (!client) {
			throw new Error(`MCP server "${server}" is not connected`);
		}

		try {
			const result = await client.callTool(tool, params, signal);
			// 成功 → 重置熔断器
			this.circuitStates.delete(server);
			return result;
		} catch (error) {
			// 失败 → 记录
			const state = this.circuitStates.get(server) ?? { failures: 0, openUntil: 0 };
			state.failures++;
			if (state.failures >= this.failureThreshold) {
				state.openUntil = Date.now() + this.circuitOpenMs;
			}
			this.circuitStates.set(server, state);
			throw error;
		}
	}

	// ── 管理操作 ──

	/** 获取所有服务器状态列表 */
	getStatusList(): McpServerStatus[] {
		return Array.from(this.configs.values()).map((config) => {
			const client = this.clients.get(config.name);
			const isConnected = client?.isConnected ?? false;
			// server 不启用 → 不可能 connected；toolCount 必须 0
			const active = config.enabled && isConnected;
			return {
				name: config.name,
				type: config.type,
				enabled: config.enabled,
				connected: active,
				connecting: config.enabled && this.clientStarts.has(config.name),
				toolCount: active ? (client?.getTools().length ?? 0) : 0,
				lastError: this.lastErrors.get(config.name),
				source: config._source,
				discoveredFrom: config._discoveredFrom,
				command: config.command,
				args: config.args,
				url: config.url,
			};
		});
	}

	/** 添加服务器配置 */
	async addServer(config: McpServerConfig): Promise<void> {
		if (this.configs.has(config.name)) {
			throw new Error(`MCP server "${config.name}" already exists`);
		}

		config._source = "user";
		this.configs.set(config.name, normalizeConfig(config));
		await this.persistConfig();
		this.notifyChange();

		if (config.enabled) {
			void this.startServer(config.name).catch(() => undefined);
		}
	}

	/** 删除服务器配置 */
	async removeServer(name: string): Promise<void> {
		const client = this.clients.get(name);
		if (client) {
			await client.disconnect();
			this.clients.delete(name);
		}
		this.clientStarts.delete(name);
		this.lastErrors.delete(name);
		this.configs.delete(name);
		await this.persistConfig();
		this.notifyChange();
	}

	/** 切换服务器启用状态 */
	async toggleServer(name: string, enabled: boolean): Promise<void> {
		const config = this.configs.get(name);
		if (!config) throw new Error(`MCP server "${name}" not found`);

		config.enabled = enabled;
		config._source = "user";
		this.lastErrors.delete(name);
		await this.persistConfig();
		this.notifyChange();

		if (enabled) {
			void this.startServer(name).catch(() => undefined);
		} else {
			const client = this.clients.get(name);
			if (client) {
				await client.disconnect();
				this.clients.delete(name);
			}
			this.clientStarts.delete(name);
			this.notifyChange();
		}
	}

	/** 更新服务器配置 */
	async updateServer(name: string, patch: Partial<McpServerConfig>): Promise<void> {
		const config = this.configs.get(name);
		if (!config) throw new Error(`MCP server "${name}" not found`);

		// 先断开旧连接
		const client = this.clients.get(name);
		if (client) {
			await client.disconnect();
			this.clients.delete(name);
		}

		// 更新配置
		Object.assign(config, patch, { _source: "user" });
		this.lastErrors.delete(name);
		await this.persistConfig();
		this.notifyChange();

		if (config.enabled) {
			void this.startServer(name).catch(() => undefined);
		}
	}

	/** 测试服务器连接 */
	async testServer(name: string): Promise<McpTestResult> {
		const config = this.configs.get(name);
		if (!config) return { success: false, error: `MCP server "${name}" not found` };

		const testClient = new McpClient(`test-${name}`, config);
		try {
			await testClient.connect();
			const tools = testClient.getTools();
			await testClient.disconnect();
			return { success: true, tools };
		} catch (error) {
			try {
				await testClient.disconnect();
			} catch {
				/* ignore */
			}
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

// ── 模块级辅助函数 ──

/** 加载 MCP 配置文件，不存在则返回空数组 */
async function loadConfigFile(filePath: string): Promise<McpServerConfig[]> {
	try {
		if (!existsSync(filePath)) return [];
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		const servers = parsed.mcpServers ?? parsed.servers ?? {};

		const results: McpServerConfig[] = [];
		for (const [name, rawConfig] of Object.entries(servers)) {
			if (typeof rawConfig !== "object" || !rawConfig) continue;
			const c = rawConfig as Record<string, unknown>;
			results.push(
				normalizeConfig({
					name,
					type: (c.type as McpServerConfig["type"]) ?? "stdio",
					command: c.command as string | undefined,
					args: c.args as string[] | undefined,
					env: c.env as Record<string, string> | undefined,
					url: c.url as string | undefined,
					headers: c.headers as Record<string, string> | undefined,
					enabled: (c.enabled as boolean) ?? true,
				}),
			);
		}
		return results;
	} catch {
		return [];
	}
}

function normalizeConfig(config: McpServerConfig): McpServerConfig {
	return {
		...config,
		type: config.type ?? "stdio",
		enabled: config.enabled ?? true,
		args: config.args ? [...config.args] : undefined,
		env: config.env ? { ...config.env } : undefined,
		headers: config.headers ? { ...config.headers } : undefined,
	};
}

function configMapsEqual(a: Map<string, McpServerConfig>, b: Map<string, McpServerConfig>): boolean {
	if (a.size !== b.size) return false;
	for (const [name, config] of a) {
		if (!mcpConfigEqual(config, b.get(name))) return false;
	}
	return true;
}

function mcpConfigEqual(a: McpServerConfig | undefined, b: McpServerConfig | undefined): boolean {
	if (!a || !b) return false;
	return JSON.stringify(stableConfigShape(a)) === JSON.stringify(stableConfigShape(b));
}

function stableConfigShape(config: McpServerConfig): Record<string, unknown> {
	return {
		name: config.name,
		type: config.type,
		command: config.command,
		args: config.args ?? [],
		env: sortRecord(config.env),
		url: config.url,
		headers: sortRecord(config.headers),
		enabled: config.enabled,
		timeout: config.timeout,
		source: config._source,
		discoveredFrom: config._discoveredFrom,
	};
}

function sortRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** 自动发现兼容的 MCP 配置（Claude Code、Cursor、VS Code 等） */
async function discoverCompatibleConfigs(cwd?: string): Promise<McpServerConfig[]> {
	const home = homedir();
	const sources = [
		{ file: path.join(home, ".claude", "mcp.json"), label: "Claude Code" },
		{ file: path.join(home, ".cursor", "mcp.json"), label: "Cursor" },
		{ file: path.join(home, ".vscode", "mcp.json"), label: "VS Code" },
	];

	const results: McpServerConfig[] = [];
	for (const source of sources) {
		const configs = await loadConfigFile(source.file);
		for (const config of configs) {
			results.push({ ...config, _source: "discovered" as const, _discoveredFrom: source.label });
		}
	}

	return results;
}
