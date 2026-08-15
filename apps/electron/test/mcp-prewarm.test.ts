// ============================================================
// MCP 预热与分层连接预算 — 回归测试
//
// 预热把 MCP 冷启动从「首个会话创建」挪到「项目激活」的空闲窗口；
// 分层预算收紧本地 stdio 的默认连接超时（30s → 5s），远程 10s，
// 显式用户配置优先。
// ============================================================

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConnectTimeoutMs } from "../src/main/mcp/client.js";
import { MCPManager } from "../src/main/mcp/manager.js";
import { ProjectService } from "../src/main/projects/project-service.js";
import { ProjectRuntimeService } from "../src/main/session/services/project-runtime-service.js";

function makeManager(): MCPManager {
	const manager = new MCPManager();
	vi.spyOn(manager, "loadConfig").mockResolvedValue(undefined);
	vi.spyOn(manager, "startEnabled").mockResolvedValue({ started: [], failed: [] });
	return manager;
}

describe("MCPManager.prewarmProject", () => {
	it("首次预热加载配置并启动已启用服务器；同项目重复调用跳过", async () => {
		const manager = makeManager();

		await manager.prewarmProject("proj-1", "/tmp/proj-1", { loadProjectConfig: false });
		expect(manager.loadConfig).toHaveBeenCalledWith("proj-1", "/tmp/proj-1", { loadProjectConfig: false });
		expect(manager.startEnabled).toHaveBeenCalledWith("proj-1");

		await manager.prewarmProject("proj-1", "/tmp/proj-1");
		expect(manager.startEnabled).toHaveBeenCalledTimes(1);
	});

	it("force 重踢预热（信任授予后补载项目级配置）", async () => {
		const manager = makeManager();

		await manager.prewarmProject("proj-1", "/tmp/proj-1", { loadProjectConfig: false });
		await manager.prewarmProject("proj-1", "/tmp/proj-1", { loadProjectConfig: true, force: true });

		expect(manager.loadConfig).toHaveBeenCalledTimes(2);
		expect(manager.startEnabled).toHaveBeenCalledTimes(2);
	});

	it("预热失败静默不抛（状态面板可见 lastError）", async () => {
		const manager = makeManager();
		vi.mocked(manager.startEnabled).mockRejectedValue(new Error("spawn failed"));

		await expect(manager.prewarmProject("proj-2", "/tmp/proj-2")).resolves.toBeUndefined();
	});

	it("部分服务器失败不上抛，仅记录", async () => {
		const manager = makeManager();
		vi.mocked(manager.startEnabled).mockResolvedValue({
			started: ["a"],
			failed: [{ name: "b", error: "timeout" }],
		});

		await expect(manager.prewarmProject("proj-3", "/tmp/proj-3")).resolves.toBeUndefined();
	});
});

describe("defaultConnectTimeoutMs 连接预算（Proma 式 30s）", () => {
	it("所有传输默认 30s：连接在后台进行，预算宽裕避免误判病态", () => {
		expect(defaultConnectTimeoutMs("stdio")).toBe(30_000);
		expect(defaultConnectTimeoutMs("http")).toBe(30_000);
		expect(defaultConnectTimeoutMs("sse")).toBe(30_000);
		expect(defaultConnectTimeoutMs(undefined)).toBe(30_000);
	});
});

describe("ensureRequiredReady 必需服务器预检", () => {
	function makeConfiguredManager(servers: Record<string, unknown>): { manager: MCPManager; cwd: string } {
		const dir = mkdtempSync(join(tmpdir(), "look-mcp-req-"));
		mkdirSync(join(dir, ".look"), { recursive: true });
		writeFileSync(join(dir, ".look", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
		const manager = new MCPManager();
		return { manager, cwd: dir };
	}

	it("只等待 required!==false 的服务器；可选服务器不参与", async () => {
		const { manager, cwd } = makeConfiguredManager({
			req: { type: "stdio", command: "node", enabled: true, required: true },
			opt: { type: "stdio", command: "node", enabled: true, required: false },
		});
		await manager.loadConfig("proj-1", cwd, { loadProjectConfig: true });
		const startServer = vi.spyOn(manager, "startServer").mockResolvedValue({ name: "x" } as never);

		const { ready } = await manager.ensureRequiredReady("proj-1", 500);
		expect(ready).toContain("req");
		expect(ready).not.toContain("opt");
		expect(startServer).toHaveBeenCalledWith("proj-1", "req");
		expect(startServer).not.toHaveBeenCalledWith("proj-1", "opt");
	});

	it("预算内未连上的必需服务器不抛错，进入 pending", async () => {
		const { manager, cwd } = makeConfiguredManager({
			slow: { type: "stdio", command: "node", enabled: true, required: true },
		});
		await manager.loadConfig("proj-1", cwd, { loadProjectConfig: true });
		vi.spyOn(manager, "startServer").mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve({ name: "slow" } as never), 10_000)),
		);

		const result = await manager.ensureRequiredReady("proj-1", 100);
		expect(result.ready).toEqual([]);
		expect(result.pending).toEqual(["slow"]);
	});

	it("无必需服务器时立即返回空结果", async () => {
		const manager = new MCPManager();
		await expect(manager.ensureRequiredReady("proj-empty", 100)).resolves.toEqual({ ready: [], pending: [] });
	});
});

describe("MCP 空闲连接回收", () => {
	it("超过空闲阈值的客户端被断开并移除", async () => {
		const manager = new MCPManager();
		const disconnect = vi.fn().mockResolvedValue(undefined);
		const fakeClient = {
			name: "idle-srv",
			idleMs: vi.fn().mockReturnValue(6 * 60_000 + 1),
			disconnect,
		} as unknown as import("../src/main/mcp/client.js").McpClient;
		(manager as unknown as { clients: Map<string, unknown> }).clients.set("proj-1:idle-srv", fakeClient);

		manager.reapIdleClients(5 * 60_000);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(disconnect).toHaveBeenCalled();
		expect((manager as unknown as { clients: Map<string, unknown> }).clients.has("proj-1:idle-srv")).toBe(false);
	});

	it("空闲未超阈值的客户端保留", () => {
		const manager = new MCPManager();
		const disconnect = vi.fn();
		const freshClient = {
			name: "fresh-srv",
			idleMs: vi.fn().mockReturnValue(60_000),
			disconnect,
		} as unknown as import("../src/main/mcp/client.js").McpClient;
		(manager as unknown as { clients: Map<string, unknown> }).clients.set("proj-1:fresh-srv", freshClient);

		manager.reapIdleClients(5 * 60_000);
		expect(disconnect).not.toHaveBeenCalled();
	});
});

describe("ProjectService 激活变更回调", () => {
	it("setActiveId 变化触发回调；相同 id 不重复触发", () => {
		const service = new ProjectService({} as never, {} as never);
		const cb = vi.fn();
		service.setOnActiveProjectChanged(cb);

		service.setActiveId("proj-a");
		service.setActiveId("proj-a"); // 同 id：新建会话等高频路径，不应重复预热
		service.setActiveId("proj-b");
		service.setActiveId(null);

		expect(cb.mock.calls.map((call) => call[0])).toEqual(["proj-a", "proj-b", null]);
	});
});

describe("ProjectRuntimeService 信任授予回调", () => {
	it("trusted=true 触发 onProjectTrusted；false 不触发", async () => {
		const onProjectTrusted = vi.fn();
		const service = new ProjectRuntimeService({
			projectService: {
				getProjectInfo: vi.fn().mockReturnValue({
					id: "proj-1",
					cwd: "/tmp/proj-1",
					valid: true,
				}),
				setTrust: vi.fn(),
			},
			sessionCatalog: { replace: vi.fn() },
			runtimeRegistry: { values: () => [] },
		});
		service.setOnProjectTrusted(onProjectTrusted);

		await service.setProjectTrust("proj-1", false);
		expect(onProjectTrusted).not.toHaveBeenCalled();

		await service.setProjectTrust("proj-1", true);
		expect(onProjectTrusted).toHaveBeenCalledWith("proj-1", "/tmp/proj-1");
	});
});
