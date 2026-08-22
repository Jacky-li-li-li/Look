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
import { getLookDir } from "@look/shared/look-storage";
import { writeJsonFileAsync } from "../utils/atomic-writer.js";
import { SerialTail } from "../utils/serial-tail.js";
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
	/** 已预热的项目（应用运行期一次；配置变更由 session_start 的 loadConfig 兜底） */
	private readonly prewarmedProjects = new Set<string>();
	/**
	 * 配置重载串行化：预热（项目激活）与 session_start 可能并发触发
	 * loadConfig，交叉的 map 变更会留下已删配置的僵尸连接。
	 */
	private readonly configLock = new SerialTail<"mcp-config">();
	private onChange: (() => void) | null = null;

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

	setOnChange(cb: () => void): void {
		this.onChange = cb;
	}

	private notifyChange(): void {
		this.onChange?.();
	}

	async loadConfig(projectId: string, cwd?: string, options: { loadProjectConfig?: boolean } = {}): Promise<void> {
		return this.configLock.run("mcp-config", async () => {
			const merged = new Map<string, McpServerConfig>();
			for (const config of await discoverCompatibleConfigs(cwd)) {
				merged.set(config.name, { ...config, _source: "discovered" });
			}
			// Project-level .look/mcp.json can spawn arbitrary stdio commands, so it
			// must be gated by project trust. The caller (MCP extension) decides
			// whether the project is trusted and passes loadProjectConfig=false
			// otherwise — the same gate that blocks .pi/* resources.
			if (cwd && options.loadProjectConfig !== false) {
				const projectConfigPath = path.join(cwd, ".look", "mcp.json");
				for (const config of await loadConfigFile(projectConfigPath)) {
					merged.set(config.name, { ...config, _source: "project" });
				}
			}
			const userConfigPath = path.join(getLookDir(), "mcp.json");
			for (const config of await loadConfigFile(userConfigPath)) {
				merged.set(config.name, { ...config, _source: "user" });
			}

			const previous = this.getProjectConfigMap(projectId);
			const changed = !configMapsEqual(previous, merged);
			const prefix = this.projectPrefix(projectId);
			for (const key of this.configs.keys()) {
				if (key.startsWith(prefix)) this.configs.delete(key);
			}
			for (const [name, config] of merged) {
				this.configs.set(this.projectKey(projectId, name), config);
			}
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
		});
	}

	async persistConfig(projectId = "global"): Promise<void> {
		const configPath = path.join(getLookDir(), "mcp.json");
		const prefix = this.projectPrefix(projectId);
		const servers: Record<string, unknown> = {};
		for (const [key, config] of this.configs) {
			if (!key.startsWith(prefix)) continue;
			if (config._source !== "user") continue;
			const { name: _name, _source: _src, _discoveredFrom: _disc, ...rest } = config;
			servers[config.name] = rest;
		}
		// 原子写：与其它 Look JSON 存储一致，进程崩溃不会留下截断的 mcp.json。
		await writeJsonFileAsync(configPath, { mcpServers: servers }, 2);
	}

	async persistProjectConfig(projectId: string, cwd: string): Promise<void> {
		const configPath = path.join(cwd, ".look", "mcp.json");
		const prefix = this.projectPrefix(projectId);
		const servers: Record<string, unknown> = {};
		for (const [key, config] of this.configs) {
			if (!key.startsWith(prefix)) continue;
			if (config._source !== "project") continue;
			const { name: _name, _source: _src, _discoveredFrom: _disc, ...rest } = config;
			servers[config.name] = rest;
		}
		await writeJsonFileAsync(configPath, { mcpServers: servers }, 2);
	}

	/**
	 * 项目激活时后台预热：加载配置并启动已启用服务器。
	 *
	 * 把 MCP 冷启动（进程 spawn + 握手）从「首个会话创建」挪到「应用启动 /
	 * 项目切换」的空闲窗口，会话创建时命中已连接客户端（startServer 的
	 * isConnected 短路）。失败静默（状态面板可见 lastError），不阻塞任何
	 * 调用方。每个项目应用运行期只预热一次；信任授予后可用 force 重踢以
	 * 加载项目级 .look/mcp.json。
	 */
	async prewarmProject(
		projectId: string,
		cwd?: string,
		options: { loadProjectConfig?: boolean; force?: boolean } = {},
	): Promise<void> {
		if (!options.force && this.prewarmedProjects.has(projectId)) return;
		this.prewarmedProjects.add(projectId);
		try {
			await this.loadConfig(projectId, cwd, { loadProjectConfig: options.loadProjectConfig });
			const { started, failed } = await this.startEnabled(projectId);
			if (failed.length > 0) {
				const detail = failed.map((f) => `${f.name} (${f.error})`).join(", ");
				console.warn(`[Look][MCP] 预热完成，部分服务器失败: ${detail}`);
			}
			if (started.length > 0) {
				console.log(`[Look][MCP] 项目 ${projectId} 预热完成: ${started.join(", ")}`);
			}
		} catch (error) {
			console.warn(
				`[Look][MCP] 项目 ${projectId} 预热失败:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/**
	 * Proma 式 required 预检：会话首条消息前等待「必需」服务器连接完成。
	 *
	 * 必需服务器保证其工具在模型首轮可用（session_start 已后台启动连接，
	 * 这里复用同一 in-flight promise，已连接的立即返回）；可选服务器
	 * （required:false）不参与等待。预算内未连上不抛错——工具会在连接
	 * 完成后动态注册，只是首轮不可见。
	 */
	async ensureRequiredReady(projectId: string, timeoutMs = 30_000): Promise<{ ready: string[]; pending: string[] }> {
		const prefix = this.projectPrefix(projectId);
		const required = Array.from(this.configs.entries()).filter(
			([key, config]) => key.startsWith(prefix) && config.enabled && config.required !== false,
		);
		if (required.length === 0) return { ready: [], pending: [] };

		const starts = required.map(async ([_key, config]) => {
			try {
				await this.startServer(projectId, config.name);
				return { name: config.name, ok: true };
			} catch {
				return { name: config.name, ok: false };
			}
		});
		// 预算超时后不再继续等待：连接仍在后台进行，工具就绪后动态注册。
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const results = await Promise.race([
				Promise.all(starts),
				new Promise<Array<{ name: string; ok: boolean }>>((resolve) => {
					timer = setTimeout(() => resolve([]), timeoutMs);
				}),
			]);
			const ready = results.filter((result) => result.ok).map((result) => result.name);
			const pending = required.map(([_key, config]) => config.name).filter((name) => !ready.includes(name));
			if (pending.length > 0) {
				console.log(
					`[Look][MCP] 必需服务器预算内未就绪（${pending.join(", ")}），本轮继续发送，工具就绪后动态注册`,
				);
			}
			return { ready, pending };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * 空闲连接回收（Proma 式连接池）：超过 idleTtlMs 未调用工具的客户端
	 * 断开并释放 stdio 子进程。周期清扫，定时器 unref 不阻止应用退出。
	 */
	startIdleReaper(intervalMs = 60_000, idleTtlMs = 5 * 60_000): void {
		const timer = setInterval(() => this.reapIdleClients(idleTtlMs), intervalMs);
		timer.unref();
	}

	/** 执行一次空闲清扫（周期回收的测试可观测入口）。 */
	reapIdleClients(idleTtlMs = 5 * 60_000, now = Date.now()): void {
		for (const [key, client] of this.clients) {
			if (client.idleMs(now) <= idleTtlMs) continue;
			void client
				.disconnect()
				.catch(() => undefined)
				.finally(() => {
					if (this.clients.get(key) === client) this.clients.delete(key);
				});
			this.lastErrors.delete(key);
			this.notifyChange();
		}
	}

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
					failed.push({ name: config.name, error: error instanceof Error ? error.message : String(error) });
				}
			});
		await Promise.allSettled(tasks);
		return { started, failed };
	}

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
			const startedAt = Date.now();
			try {
				await client.connect();
				if (this.clients.get(key) !== client || !this.configs.get(key)?.enabled) {
					await client.disconnect();
					throw new Error(`MCP server "${name}" start was cancelled`);
				}
				this.lastErrors.delete(key);
				// 连接耗时观测：本地 stdio 超过 3s 即视为病态（冷启动通常
				// <1.5s），现场可直接从日志定位慢服务器并调整其预算/配置。
				const elapsed = Date.now() - startedAt;
				if (elapsed > 3_000) {
					console.warn(`[Look][MCP] slow server "${name}": connected in ${elapsed}ms (${config.type})`);
				} else {
					console.log(`[Look][MCP] "${name}" connected in ${elapsed}ms (${config.type})`);
				}
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

	async stopAll(): Promise<void> {
		const tasks = Array.from(this.clients.values()).map((c) => c.disconnect());
		await Promise.allSettled(tasks);
		this.clients.clear();
		this.clientStarts.clear();
		this.circuitStates.clear();
		this.lastErrors.clear();
	}

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

	async executeTool(
		projectId: string,
		server: string,
		tool: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		const key = this.projectKey(projectId, server);
		const circuit = this.circuitStates.get(key);
		if (circuit && circuit.failures >= this.failureThreshold) {
			if (Date.now() < circuit.openUntil) {
				throw new Error(
					`MCP server "${server}" circuit breaker is open. Retry after ${new Date(circuit.openUntil).toLocaleTimeString()}`,
				);
			}
			this.circuitStates.delete(key);
		}
		const client = this.clients.get(key);
		if (!client) throw new Error(`MCP server "${server}" is not connected`);
		try {
			const result = await client.callTool(tool, params, signal);
			this.circuitStates.delete(key);
			return result;
		} catch (error) {
			const state = this.circuitStates.get(key) ?? { failures: 0, openUntil: 0 };
			state.failures++;
			if (state.failures >= this.failureThreshold) state.openUntil = Date.now() + this.circuitOpenMs;
			this.circuitStates.set(key, state);
			throw error;
		}
	}

	getStatusList(projectId: string): McpServerStatus[] {
		const prefix = this.projectPrefix(projectId);
		return Array.from(this.configs.entries())
			.filter(([key]) => key.startsWith(prefix))
			.map(([_key, config]) => {
				const clientKey = this.projectKey(projectId, config.name);
				const client = this.clients.get(clientKey);
				const isConnected = client?.isConnected ?? false;
				const active = config.enabled && isConnected;
				return {
					name: config.name,
					type: config.type,
					enabled: config.enabled,
					required: config.required !== false,
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

	async addServer(projectId: string, config: McpServerConfig, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, config.name);
		if (this.configs.has(key)) throw new Error(`MCP server "${config.name}" already exists`);
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

	async updateServer(projectId: string, name: string, patch: Partial<McpServerConfig>, cwd?: string): Promise<void> {
		const key = this.projectKey(projectId, name);
		const config = this.configs.get(key);
		if (!config) throw new Error(`MCP server "${name}" not found`);
		const client = this.clients.get(key);
		if (client) {
			await client.disconnect();
			this.clients.delete(key);
		}
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
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

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
					required: typeof c.required === "boolean" ? c.required : undefined,
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

async function discoverCompatibleConfigs(_cwd?: string): Promise<McpServerConfig[]> {
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
