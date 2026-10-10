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
import { getLookDir, getProjectsIndexPath } from "@look/shared/look-storage";
import { writeJsonFileAsync } from "../utils/atomic-writer.js";
import { SerialTail } from "../utils/serial-tail.js";
import { McpClient } from "./client.js";
import type { McpCallResult, McpServerConfig, McpServerStatus, McpTestResult, McpTool } from "./types.js";

/** 熔断器状态 */
interface CircuitState {
	failures: number;
	openUntil: number;
}

export interface MCPManagerOptions {
	/** 第三方 IDE 配置发现的 home 目录（测试注入；默认 os.homedir()）。 */
	discoveryHome?: string;
}

/**
 * 一次性迁移标记：记录"第三方 MCP 配置需显式启用"策略已对本机生效。
 * 存在即表示迁移已完成（不论是否 grandfather 了任何服务器）。
 */
const DISCOVERY_CONSENT_MARKER = "mcp-discovery-consent.json";

export class MCPManager {
	constructor(private readonly options: MCPManagerOptions = {}) {}

	/** 本进程内是否已完成发现配置的同意迁移检查。 */
	private discoveryMigrationChecked = false;
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
	/** 空闲回收定时器句柄（应用退出前 stopIdleReaper 清理）。 */
	private idleReaperTimer: NodeJS.Timeout | null = null;

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

	/**
	 * 加载并合并 MCP 配置。
	 *
	 * - `loadProjectConfig` 必填（fail-closed）：项目级 .look/mcp.json 可 spawn 任意命令，
	 *   调用方必须基于 project trust 显式决定是否加载。
	 * - 第三方 IDE 全局配置（~/.claude|.cursor|.vscode/mcp.json）只作为"已发现"条目列出，
	 *   一律 `enabled: false`；用户在设置页启用（toggleServer）后才会转为 user 配置并连接，
	 *   即显式同意。升级前已在使用的老用户由 migrateDiscoveryConsent 一次性迁移保留。
	 */
	async loadConfig(
		projectId: string,
		cwd: string | undefined,
		options: { loadProjectConfig: boolean },
	): Promise<void> {
		return this.configLock.run("mcp-config", async () => {
			const merged = new Map<string, McpServerConfig>();
			const discovered = await discoverCompatibleConfigs(this.options.discoveryHome ?? homedir());
			await this.migrateDiscoveryConsent(discovered);
			for (const config of discovered) {
				merged.set(config.name, { ...config, enabled: false, _source: "discovered" });
			}
			// Project-level .look/mcp.json can spawn arbitrary stdio commands, so it
			// must be gated by project trust. The caller (MCP extension) decides
			// whether the project is trusted and passes loadProjectConfig=false
			// otherwise — the same gate that blocks .pi/* resources.
			if (cwd && options.loadProjectConfig === true) {
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

	/**
	 * 向后兼容迁移（每台机器一次）：旧版本会自动启用第三方 IDE 的 MCP 配置。
	 * 对**已有安装**（LOOK_HOME 下已存在 projects 索引），把当时已启用的发现配置
	 * 写入 ~/.look/mcp.json 作为 user 配置，保持升级前行为；全新安装不做任何
	 * 自动启用。完成后写入标记文件，之后新出现的第三方配置都需要用户显式启用。
	 */
	private async migrateDiscoveryConsent(discovered: McpServerConfig[]): Promise<void> {
		if (this.discoveryMigrationChecked) return;
		this.discoveryMigrationChecked = true;
		const lookDir = getLookDir();
		const markerPath = path.join(lookDir, DISCOVERY_CONSENT_MARKER);
		if (existsSync(markerPath)) return;
		const existingInstall = existsSync(getProjectsIndexPath());
		const grandfathered: string[] = [];
		if (existingInstall) {
			const userConfigPath = path.join(lookDir, "mcp.json");
			let raw: { mcpServers?: Record<string, unknown> } = {};
			if (existsSync(userConfigPath)) {
				try {
					raw = JSON.parse(await readFile(userConfigPath, "utf-8"));
				} catch {
					// 用户配置损坏：不迁移、不覆盖（loadConfigFile 会告警），也不写标记，下次重试
					this.discoveryMigrationChecked = false;
					return;
				}
			}
			const servers: Record<string, unknown> = { ...(raw.mcpServers ?? {}) };
			for (const config of discovered) {
				if (!config.enabled || config.name in servers) continue;
				const { name: _n, _source: _s, _discoveredFrom: _d, ...rest } = config;
				servers[config.name] = rest;
				grandfathered.push(config.name);
			}
			if (grandfathered.length > 0) {
				await writeJsonFileAsync(userConfigPath, { ...raw, mcpServers: servers }, 2);
				console.log(`[Look][MCP] 已将升级前自动启用的第三方 MCP 配置迁移为用户配置: ${grandfathered.join(", ")}`);
			}
		}
		await writeJsonFileAsync(markerPath, { version: 1, migratedAt: new Date().toISOString(), grandfathered }, 2);
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
			await this.loadConfig(projectId, cwd, { loadProjectConfig: options.loadProjectConfig === true });
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
	 * 重复调用幂等：先停掉既有定时器再重建。
	 */
	startIdleReaper(intervalMs = 60_000, idleTtlMs = 5 * 60_000): void {
		this.stopIdleReaper();
		const timer = setInterval(() => this.reapIdleClients(idleTtlMs), intervalMs);
		timer.unref();
		this.idleReaperTimer = timer;
	}

	/** 停止空闲回收定时器（应用退出/测试清理）。 */
	stopIdleReaper(): void {
		if (this.idleReaperTimer) {
			clearInterval(this.idleReaperTimer);
			this.idleReaperTimer = null;
		}
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
	// 只有文件不存在才静默（未配置是正常情况）；解析失败必须告警，
	// 否则用户在项目里手写的 mcp.json 多一个逗号就会让全部 MCP server 无声消失。
	if (!existsSync(filePath)) return [];
	try {
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
	} catch (error) {
		console.warn(
			`[MCP] 无法解析配置文件 ${filePath}，该文件的 MCP 配置已被跳过:`,
			error instanceof Error ? error.message : String(error),
		);
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

async function discoverCompatibleConfigs(home: string): Promise<McpServerConfig[]> {
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
