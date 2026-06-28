// ============================================================
// Stage 2 集成测试：Agent 开关行为验证
// 不需真实 LLM，直接测试 SessionRuntimeManager 的开关逻辑。
// ============================================================

import { afterAll, describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session-runtime-manager";

describe("SubAgent toggle — API-level behavior", () => {
	const manager = new SessionRuntimeManager();
	let savedDefault: boolean;

	afterAll(async () => {
		// 恢复默认
		await manager.setSubagentEnabledGlobal(savedDefault);
	});

	it("1. default is true (new sessions have subagent enabled)", async () => {
		const settings = manager.getGeneralSettings();
		savedDefault = settings.subagentEnabled;
		expect(settings.subagentEnabled).toBe(true);

		await manager.setSubagentEnabledGlobal(true);
		expect(manager.getGeneralSettings().subagentEnabled).toBe(true);
	});

	it("2. setSubagentEnabledGlobal(false) persists and applies", async () => {
		await manager.setSubagentEnabledGlobal(false);
		expect(manager.getGeneralSettings().subagentEnabled).toBe(false);
		// 从 map 读（没有 live session 时回退到全局默认）
		expect(manager.isSubagentEnabled("nonexistent-session")).toBe(false);
	});

	it("3. setSubagentEnabledGlobal(true) restores", async () => {
		await manager.setSubagentEnabledGlobal(true);
		expect(manager.getGeneralSettings().subagentEnabled).toBe(true);
		expect(manager.isSubagentEnabled("nonexistent-session")).toBe(true);
	});

	it("4. persistence round-trip via updateGeneralSettings", async () => {
		await manager.updateGeneralSettings({ subagentEnabled: false });
		expect(manager.getGeneralSettings().subagentEnabled).toBe(false);

		await manager.updateGeneralSettings({ subagentEnabled: true });
		expect(manager.getGeneralSettings().subagentEnabled).toBe(true);
	});

	it("5. resetGeneralSettings restores default", async () => {
		await manager.setSubagentEnabledGlobal(false);
		const reset = await manager.resetGeneralSettings();
		expect(reset.subagentEnabled).toBe(true);
		expect(manager.getGeneralSettings().subagentEnabled).toBe(true);
	});

	it("6. per-session state is tracked independently via map", async () => {
		// New sessions default to global default (currently true)
		expect(manager.isSubagentEnabled("session-x")).toBe(true);

		// setSubagentEnabledGlobal(false) → applies to default, not individual entries
		await manager.setSubagentEnabledGlobal(false);
		expect(manager.isSubagentEnabled("session-x")).toBe(false);

		await manager.setSubagentEnabledGlobal(true);
		expect(manager.isSubagentEnabled("session-x")).toBe(true);
	});
});
