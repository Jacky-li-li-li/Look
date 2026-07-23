// ============================================================
// MCP Manager
//
// 管理所有 MCP 客户端的生命周期：配置加载、启动、停止、
// 工具聚合、状态查询、熔断保护。
// ============================================================

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

	/** 生成 project 隔离的复合键。 */
	private projectKey(projectId: string, name: string): string {
		return `${projectId}:${name}`;
	}

	private projectPrefix(projectId: string): string {
		return `${projectId}:`;
	}

	private getProjectConfigMap(projectId: string): Map<string, McpServerConfig> {
		const prefix = this.projectPrefix(projectId);
		const map = new Map<string, McpServerConfig>();
		for (const [key, config] of this.configs) {
			if (key.startsWith(prefix)) {
				map.set(config.name, config);
			}
		}
		return map;
	}

	/** 注册变更回调 — 当服务器列表变化时通知渲染进程。 */
	setOnChange(cb: () => void): void {
		this.onChange = cb;
	}

	private notifyChange(): void {
		this.onChange?.();
	}

	// ── 配置加载 ──

	/**
	 * 加载并合并指定 project 的 MCP 服务器配置。
	 * 优先级：用户级 > 项目级 > 自动发现
	 */
	async loadConfig(projectId: string, cwd?: string): Promise<void> {
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

		const previous = this.getProjectConfigMap(projectId);
		const changed = !configMapsEqual(previous, merged);

		// 仅替换本 project 命名空间下的配置
		const prefix = this.projectPrefix(projectId);
		for (const key of this.configs.keys()) {
			if (key.startsWith(prefix)) {
				this.configs.delete(key);
			}
		}
		for (const [name, config] of merged) {
			this.configs.set(this.projectKey(projectId, name), config);
		}

		// 清理已从配置中移除、禁用或连接参数变化的客户端连接。
		for (const [key, client] of this.clients) {
			if (!key.startsWith(prefix)) continue;
			const name = key.slice(prefix.length);
			const nextConfig = merged.get(name);
			if (!nextConfig?.enabled || !mcpConfigEqual(previous.get(name), nextConfig)) {
				await client.disconnect();
				this.clients.delete(key);
			}
		}
		if (changed) this.notifyChange();
	}

	/**
	 * 持久化用户级配置到 ~/.look/mcp.json。
	 * 只持久化指定 project 命名空间中 _source === "user" 的配置。
	 */
	async persistConfig(projectId = "global"): Promise<void> {
		const lookDir = path.join(homedir(), ".look");
		const configPath = path.join(lookDir, "mcp.json");

		await mkdir(lookDir, { recursive: true });

		const prefix = this.projectPrefix(projectId);
		const servers: Record<string, unknown> = {};
		for (const [key, config] of this.configs) {
			if (!key.startsWith(prefix)) continue;
			if (config._source !== "user") continue;
			const { name: _name, _source: _src, _discoveredFrom: _disc, ...rest } = config;
			servers[config.name] = rest;
		}

		await writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
	}

	/**
	 * 持久化项目级配置到 <cwd>/.look/mcp.json。
	 * 只持久化 _source === "project" 的配置。
	 */
	async persistProjectConfig(projectId: string, cwd: string): Promise<void> {
		const lookDir = path.join(cwd, ".look");
		const configPath = path.join(lookDir, "mcp.json");

		await mkdir(lookDir, { recursive: true });

		const prefix = this.projectPrefix(projectId);
		const servers: Record<string, unknown> = {};
		for (const [key, config] of this.configs) {
			if (!key.startsWith(prefix)) continue;
			if (config._source !== "project") continue;
			const { name: _name, _source: _src, _discoveredFrom: _disc, ...rest } = config;
			servers[config.name] = rest;
		}

		await writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
	}

	// ── 生命周期 ──

	/**
	 * 并行启动指定 project 下所有已启用的服务器。
	 * 单个服务器启动失败不影响其他服务器。
	 */
	async startEnabled(projectId: string): Promise<{
		started: string[];
		failed: Array<{ name: string; error: string }>;
	}> {
		const started: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		const prefix = this.projectPrefix(projectId);
		const tasks = Array.from(this.configs.entries())
			.filter(([key, c]) => key.startsWith(prefix) && c.enabled)
			.map(async ([_key, config]) => {
				try {
					await this.startServer(projectId, config.name);
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
	async startServer(projectId: string, name: string): Promise<McpClient> {
		const key = this.projectKey(projectId, name);
		const config = this.configs.get(key);
		if (!config) throw new Error(`MCP server "${name}" not found`);
		if (!config.enabled) throw new Error(`MCP server "${name}" is disabled`);

		const existing = this.clients.get(key);
		if (existing?.isConnected) return existing;

		const pending = this.clientStarts.get(key);
		if (pending) return pending;

		const start = (async () => {
			const stale = this.clients.get(key);
			if (stale) {
				await stale.disconnect();
				this.clients.delete(key);
			}

			const client = new McpClient(name, config);
			this.clients.set(key, client);
			this.lastErrors.delete(key);
			this.notifyChange();

			try {
				await client.connect();
				if (this.clients.get(key) !== client || !this.configs.get(key)?.enabled) {
					await client.disconnect();
					throw new Error(`MCP server "${name}" start was cancelled`);
				}
				this.lastErrors.delete(key);
				return client;
			} catch (error) {
				if (this.clients.get(key) === client) this.clients.delete(key);
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("start was cancelled")) this.lastErrors.set(key, message);
				throw error;
			} finally {
				this.clientStarts.delete(key);
				this.notifyChange();
			}
		})();

		this.clientStarts.set(key, start);
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
	getToolsForServer(projectId: string, name: string): McpTool[] {
		const client = this.clients.get(this.projectKey(projectId, name));
		return client?.getTools() ?? [];
	}

	getAllTools(projectId: string): Array<{ server: string; tool: McpTool }> {
		const prefix = this.projectPrefix(projectId);
		const result: Array<{ server: string; tool: McpTool }> = [];
		for (const [key, client] of this.clients) {
			if (!key.startsWith(prefix)) continue;
			if (!client.isConnected) continue;
			const serverName = key.slice(prefix.length);
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
	async executeTool(
		projectId: string,
		server: string,
		tool: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		const key = this.projectKey(projectId, server);

		// 熔断器检查
		const circuit = this.circuitStates.get(key);
		if (circuit && circuit.failures >= this.failureThreshold) {
			if (Date.now() < circuit.openUntil) {
				throw new Error(
					`MCP server "${server}" circuit breaker is open. ` +
						`Retry after ${new Date(circuit.openUntil).toLocaleTimeString()}`,
				);
			}
			// 半开状态：允许一次尝试
			this.circuitStates.delete(key);
		}

		const client = this.clients.get(key);
		if (!client) {
			throw new Error(`MCP server "${server}" is not connected`);
		}

		try {
			const result = await client.callTool(tool, params, signal);
			// 成功 → 重置熔断器
			this.circuitStates.delete(key);
			return result;
		} catch (error) {
			// 失败 → 记录
			const state = this.circuitStates.get(key) ?? { failures: 0, openUntil: 0 };
			state.failures++;
			if (state.failures >= this.failureThreshold) {
				state.openUntil = Date.now() + this.circuitOpenMs;
			}
			this.circuitStates.set(key, state);
			throw error;
		}
	}

	// ── 管理操作 ──

	/** 获取指定 project 下所有服务器状态列表 */
	getStatusList(projectId: string): McpServerStatus[] {
		const prefix = this.projectPrefix(projectId);
		return Array.from(this.configs.entries())
			.filter(([key]) => key.startsWith(prefix))
			.map(([_key, config]) => {
				const clientKey = this.projectKey(projectId, config.name);
				const client = this.clients.get(clientKey);
				const isConnected = client?.isConnected ?? false;
				// server 不启用 → 不可能 connected；toolCount 必须 0
				const active = config.enabled && isConnected;
				return {
					name: config.name,
					type: config.type,
					enabled: config.enabled,
					connected: active,
					connecting: config.enabled && this.clientStarts.has(clientKey),
					toolCount: active ? (client?.getTools().length ?? 0) : 0,
					lastError: this.lastErrors.get(clientKey),
					source: config._source,
					discoveredFrom: config._discoveredFrom,
					command: config.command,
					args: config.args,
					url: config.url,
				};
			});
	}

	/** 添加服务器配置 */
	async addServer(projectId: string, config: McpServerConfig, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, config.name);
		if (this.configs.has(key)) {
			throw new Error(`MCP server "${config.name}" already exists`);
		}

		const normalized = normalizeConfig(config);
		if (projectId !== "global" && cwd) {
			normalized._source = "project";
			this.configs.set(key, normalized);
			await this.persistProjectConfig(projectId, cwd);
		} else {
			normalized._source = "user";
			this.configs.set(key, normalized);
			await this.persistConfig(projectId);
		}
		this.notifyChange();

		if (normalized.enabled) {
			void this.startServer(projectId, normalized.name).catch(() => undefined);
		}
	}

	/** 删除服务器配置 */
	async removeServer(projectId: string, name: string, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, name);
		const config = this.configs.get(key);
		const client = this.clients.get(key);
		if (client) {
			await client.disconnect();
			this.clients.delete(key);
		}
		this.clientStarts.delete(key);
		this.lastErrors.delete(key);
		this.circuitStates.delete(key);
		this.configs.delete(key);

		if (config?._source === "project" && cwd) {
			await this.persistProjectConfig(projectId, cwd);
		} else {
			await this.persistConfig(projectId);
		}
		this.notifyChange();
	}

	/** 切换服务器启用状态 */
	async toggleServer(projectId: string, name: string, enabled: boolean, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, name);
		const config = this.configs.get(key);
		if (!config) throw new Error(`MCP server "${name}" not found`);

		config.enabled = enabled;
		if (projectId !== "global" && cwd) {
			config._source = "project";
		} else {
			config._source = "user";
		}
		this.lastErrors.delete(key);

		if (config._source === "project" && cwd) {
			await this.persistProjectConfig(projectId, cwd);
		} else {
			await this.persistConfig(projectId);
		}
		this.notifyChange();

		if (enabled) {
			void this.startServer(projectId, name).catch(() => undefined);
		} else {
			const client = this.clients.get(key);
			if (client) {
				await client.disconnect();
				this.clients.delete(key);
			}
			this.clientStarts.delete(key);
			this.notifyChange();
		}
	}

	/** 更新服务器配置 */
	async updateServer(projectId: string, name: string, patch: Partial<McpServerConfig>, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, name);
		const config = this.configs.get(key);
		if (!config) throw new Error(`MCP server "${name}" not found`);

		// 先断开旧连接
		const client = this.clients.get(key);
		if (client) {
			await client.disconnect();
			this.clients.delete(key);
		}

		// 更新配置
		const nextSource = projectId !== "global" && cwd ? "project" : "user";
		Object.assign(config, patch, { _source: nextSource });
		this.lastErrors.delete(key);

		if (config._source === "project" && cwd) {
			await this.persistProjectConfig(projectId, cwd);
		} else {
			await this.persistConfig(projectId);
		}
		this.notifyChange();

		if (config.enabled) {
			void this.startServer(projectId, name).catch(() => undefined);
		}
	}

	/** 测试服务器连接 */
	async testServer(projectId: string, name: string): Promise<McpTestResult> {
		const config = this.configs.get(this.projectKey(projectId, name));
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
