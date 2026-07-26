// ============================================================
// Stage 2 集成测试：Agent 开关行为验证
// 不需真实 LLM，直接测试 SessionRuntimeManager 的开关逻辑。
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session/runtime-manager.js";

/** Test-only access to SessionRuntimeManager internals. */
interface TestManagerInternals {
	runtimeRegistry: {
		set(
			sessionId: string,
			runtime: {
				runtime: { session: Record<string, unknown> };
				projectId: string;
				cwd: string;
				createdAt: number;
				binding: { sessionId: string; sessionManager: Record<string, unknown> };
				unsubscribe: () => void;
			},
		): void;
		delete(sessionId: string): boolean;
	};
	permissionService: { setMode: (id: string, mode: string) => void; disposeSession: (id: string) => void };
	planService: { disposeSession: (id: string) => void };
	sessionSubagentService: { clearSession(sessionId: string): void };
}

function installFakeRuntime(
	manager: SessionRuntimeManager,
	sessionId: string,
	activeTools: string[],
	allTools: string[],
) {
	let active = [...activeTools];
	const sessionManager = { isPersisted: () => false };
	const session = {
		getActiveToolNames: () => [...active],
		setActiveToolsByName: (tools: string[]) => {
			active = [...tools];
		},
		getAllTools: () => allTools.map((name) => ({ name })),
		sessionManager,
	};
	const internal = manager.composition as unknown as TestManagerInternals;
	internal.runtimeRegistry.set(sessionId, {
		runtime: { session },
		projectId: "test-project",
		cwd: "/project",
		createdAt: Date.now(),
		binding: { sessionId, sessionManager },
		unsubscribe: () => {},
	});
	internal.permissionService.setMode(sessionId, "ask");
	return {
		getActiveTools: () => [...active],
		cleanup: () => {
			internal.runtimeRegistry.delete(sessionId);
			internal.permissionService.disposeSession(sessionId);
			internal.planService.disposeSession(sessionId);
			try {
				internal.sessionSubagentService?.clearSession(sessionId);
			} catch {
				/* ignore if subagent service not fully initialized */
			}
		},
	};
}

describe("SubAgent toggle — API-level behavior", () => {
	let manager: SessionRuntimeManager;
	let savedDefault: boolean;

	beforeAll(async () => {
		manager = await SessionRuntimeManager.create();
		// 确保从干净的默认状态开始（避免前序测试残留影响）
		const clean = await manager.resetGeneralSettings();
		savedDefault = clean.subagentEnabled;
	}, 30_000);

	afterAll(async () => {
		// 恢复默认
		if (manager) await manager.setSubagentEnabledGlobal(savedDefault);
	}, 30_000);

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

	it("7. enabling only adds subagent tools and does not restore all configured tools", async () => {
		const fake = installFakeRuntime(
			manager,
			"fake-toggle-session",
			["read"],
			["read", "write", "bash", "subagent", "subagent_parallel", "subagent_chain"],
		);
		try {
			await manager.setSubagentEnabled("fake-toggle-session", true);
			expect(fake.getActiveTools()).toEqual(["read", "subagent", "subagent_parallel", "subagent_chain"]);
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
			(manager.composition as unknown as TestManagerInternals).permissionService.setMode(
				"fake-plan-session",
				"plan",
			);
			await manager.setSubagentEnabled("fake-plan-session", true);
			expect(fake.getActiveTools()).toEqual(["read", "bash", "AskUserQuestion", "ExitPlanMode"]);
		} finally {
			fake.cleanup();
		}
	});

	it("9. disabling only removes subagent tools from the current active tools", async () => {
		const fake = installFakeRuntime(
			manager,
			"fake-disable-session",
			["read", "custom-tool", "subagent", "subagent_parallel", "subagent_chain"],
			["read", "write", "custom-tool", "subagent", "subagent_parallel", "subagent_chain"],
		);
		try {
			await manager.setSubagentEnabled("fake-disable-session", false);
			expect(fake.getActiveTools()).toEqual(["read", "custom-tool"]);
		} finally {
			fake.cleanup();
		}
	});
});
