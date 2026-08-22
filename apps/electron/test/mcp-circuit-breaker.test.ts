// ============================================================
// MCP 熔断器（circuit breaker）回归测试
//
// MCPManager.executeTool 内嵌熔断器：连续失败达阈值 → 开路，开路期间
// 直接抛 "circuit breaker is open" 不触达客户端；开路超时后半开重试；
// 成功即清零。空闲回收已在 mcp-prewarm.test.ts 覆盖，此处补熔断器。
//
// LOOK_HOME 隔离同 mcp-prewarm.test.ts（look-storage 模块加载即缓存
// LOOK_DIR）。被测模块动态导入。
// ============================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let lookHome: string;

beforeEach(async () => {
	lookHome = await mkdtemp(join(tmpdir(), "look-mcp-cb-"));
	vi.stubEnv("LOOK_HOME", lookHome);
	vi.resetModules();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(lookHome, { recursive: true, force: true });
});

type McpClient = import("../src/main/mcp/client.js").McpClient;
type MCPManager = import("../src/main/mcp/manager.js").MCPManager;

async function makeManager(): Promise<MCPManager> {
	const { MCPManager } = await import("../src/main/mcp/manager.js");
	const manager = new MCPManager();
	// 熔断器测试不读盘，但 executeTool 不触发 loadConfig；无需 mock。
	return manager;
}

/** 注入一个伪客户端（避免起真实 stdio 子进程），返回 callTool spy。 */
function seedClient(
	manager: MCPManager,
	key: string,
	callToolImpl: (name: string) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
	const callTool = vi.fn(callToolImpl);
	const fake = {
		name: key.split(":").pop(),
		isConnected: true,
		callTool,
		getTools: () => [],
		idleMs: () => 0,
		disconnect: () => Promise.resolve(),
		touch: () => undefined,
	} as unknown as McpClient;
	(manager as unknown as { clients: Map<string, McpClient> }).clients.set(key, fake);
	return callTool;
}

function circuitState(manager: MCPManager, key: string): { failures: number; openUntil: number } | undefined {
	return (
		manager as unknown as { circuitStates: Map<string, { failures: number; openUntil: number }> }
	).circuitStates.get(key);
}

describe("MCP circuit breaker", () => {
	it("连续失败达阈值(5)后开路：开路期间不触达客户端", async () => {
		const manager = await makeManager();
		const key = "proj-1:failing";
		const callTool = seedClient(manager, key, () => Promise.reject(new Error("boom")));

		// 前 5 次失败：每次都触达客户端、抛出原始错误，failure 累加。
		for (let i = 1; i <= 5; i++) {
			await expect(manager.executeTool("proj-1", "failing", "t", {})).rejects.toThrow("boom");
			expect(callTool).toHaveBeenCalledTimes(i);
			const state = circuitState(manager, key);
			expect(state?.failures).toBe(i);
			if (i >= 5) {
				expect(state?.openUntil).toBeGreaterThan(Date.now());
			}
		}

		// 第 6 次：熔断器开路，executeTool 在触达客户端前即抛错。
		await expect(manager.executeTool("proj-1", "failing", "t", {})).rejects.toThrow(/circuit breaker is open/);
		expect(callTool).toHaveBeenCalledTimes(5); // 未增加
	});

	it("成功即清零熔断状态", async () => {
		const manager = await makeManager();
		const key = "proj-1:recover";
		// 先注入 2 次失败累计。
		(manager as unknown as { circuitStates: Map<string, { failures: number; openUntil: number }> }).circuitStates.set(
			key,
			{ failures: 2, openUntil: 0 },
		);
		const callTool = seedClient(manager, key, () => Promise.resolve({ content: [] }));

		await manager.executeTool("proj-1", "recover", "t", {});
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(circuitState(manager, key)).toBeUndefined();
	});

	it("开路超时后半开重试：允许一次触达，失败则重新计数", async () => {
		const manager = await makeManager();
		const key = "proj-1:halfopen";
		// 注入已开路但 openUntil 已过期的状态。
		(manager as unknown as { circuitStates: Map<string, { failures: number; openUntil: number }> }).circuitStates.set(
			key,
			{ failures: 5, openUntil: Date.now() - 1_000 },
		);
		const callTool = seedClient(manager, key, () => Promise.reject(new Error("still broken")));

		// 进入 executeTool：开路已过期 → 删除旧状态 → 触达客户端 → 失败重计 1。
		await expect(manager.executeTool("proj-1", "halfopen", "t", {})).rejects.toThrow("still broken");
		expect(callTool).toHaveBeenCalledTimes(1);
		const state = circuitState(manager, key);
		expect(state?.failures).toBe(1);
		expect(state?.openUntil).toBe(0); // 未再次达阈值
	});

	it("无连接客户端时抛明确错误（不触发熔断计数）", async () => {
		const manager = await makeManager();
		// 不 seed 任何客户端。
		await expect(manager.executeTool("proj-1", "absent", "t", {})).rejects.toThrow(/is not connected/);
		// 抛在熔断逻辑之外，不应写入熔断状态。
		expect(circuitState(manager, "proj-1:absent")).toBeUndefined();
	});
});
