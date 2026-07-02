// ============================================================
// Stage 2 集成测试：Agent 开关行为验证
// 不需真实 LLM，直接测试 SessionRuntimeManager 的开关逻辑。
// ============================================================

import { afterAll, describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session-runtime-manager";

function installFakeRuntime(manager: SessionRuntimeManager, sessionId: string, activeTools: string[], allTools: string[]) {
	let active = [...activeTools];
	const session = {
		getActiveToolNames: () => [...active],
		setActiveToolsByName: (tools: string[]) => {
			active = [...tools];
		},
		getAllTools: () => allTools.map((name) => ({ name })),
		sessionManager: { isPersisted: () => false },
	};
	const internal = manager as any;
	internal.runtimes.set(sessionId, {
		runtime: { session },
		projectId: "test-project",
		createdAt: Date.now(),
		unsubscribe: () => {},
	});
	internal.permissionService.setMode(sessionId, "ask");
	return {
		getActiveTools: () => [...active],
		cleanup: () => {
			internal.runtimes.delete(sessionId);
			internal.permissionService.disposeSession(sessionId);
			internal.planService.disposeSession(sessionId);
			internal.subagentEnabledBySession.delete(sessionId);
		},
	};
}

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

	it("7. enabling only adds subagent and does not restore all configured tools", async () => {
		const fake = installFakeRuntime(manager, "fake-toggle-session", ["read"], ["read", "write", "bash", "subagent"]);
		try {
			await (manager as any).applySubagentEnabled("fake-toggle-session", true);
			expect(fake.getActiveTools()).toEqual(["read", "subagent"]);
		} finally {
			fake.cleanup();
		}
	});

	it("8. plan mode toggle keeps Plan tool restrictions instead of restoring mutations", async () => {
		const fake = installFakeRuntime(
			manager,
			"fake-plan-session",
			["read", "write", "bash", "subagent"],
			["read", "write", "bash", "subagent", "AskUserQuestion", "ExitPlanMode"],
		);
		try {
			(manager as any).permissionService.setMode("fake-plan-session", "plan");
			await (manager as any).applySubagentEnabled("fake-plan-session", true);
			expect(fake.getActiveTools()).toEqual(["read", "bash", "AskUserQuestion", "ExitPlanMode"]);
		} finally {
			fake.cleanup();
		}
	});

	it("9. disabling only removes subagent from the current active tools", async () => {
		const fake = installFakeRuntime(
			manager,
			"fake-disable-session",
			["read", "custom-tool", "subagent"],
			["read", "write", "custom-tool", "subagent"],
		);
		try {
			await (manager as any).applySubagentEnabled("fake-disable-session", false);
			expect(fake.getActiveTools()).toEqual(["read", "custom-tool"]);
		} finally {
			fake.cleanup();
		}
	});
});
