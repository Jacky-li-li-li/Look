// ============================================================
// SessionInfoService — subagent marker projection tests
//
// Regression: after a sub-session runtime is disposed and the
// SubAgentRegistry entry is unregistered (5-min cleanup), the sidebar
// row must keep parentSessionId / isSubagentSession from the persisted
// JSONL metadata instead of being promoted to a top-level session.
// ============================================================

import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWorkspaceDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../src/main/session/services/session-catalog.js";
import { SessionInfoService } from "../src/main/session/services/session-info-service.js";
import { SubAgentRegistry } from "../src/main/session/subagent-registry.js";

function writeSubsession(projectId: string, file: string): void {
	ensureWorkspaceDir(projectId);
	fs.mkdirSync(getWorkspaceSubsessionsDir(projectId), { recursive: true });
	fs.writeFileSync(
		path.join(getWorkspaceSubsessionsDir(projectId), file),
		[
			JSON.stringify({ type: "session", id: "child-1", timestamp: "2026-01-02T00:00:00.000Z" }),
			JSON.stringify({ type: "session_info", name: "Agent：review" }),
			JSON.stringify({
				type: "custom",
				customType: "look.subagent-parent.v1",
				data: { parentSessionId: "parent-1", agentName: "Agent：review" },
			}),
			JSON.stringify({ type: "message", message: { content: "Inspect the change", timestamp: 1 } }),
		].join("\n"),
	);
}

describe("SessionInfoService subagent markers", () => {
	it("keeps parentSessionId after the child runtime is disposed and unregistered", async () => {
		const projectId = "proj-info-parent-1";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-info-cwd-"));
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };
		writeSubsession(projectId, "child.jsonl");

		const catalog = new SessionCatalog();
		await catalog.refresh(project);

		// 模拟子会话完成 → 5 分钟清理 → disposeRuntime + registry.unregister。
		const registry = new SubAgentRegistry();
		registry.register("parent-1", "child-1", "Agent：review");
		registry.unregister("child-1");

		const service = new SessionInfoService({
			runtimeRegistry: { get: () => undefined, entries: () => new Map().entries() },
			sessionCatalog: catalog,
			subAgentRegistry: registry,
			scopeRegistry: { get: () => undefined },
			maxNameLength: 120,
			listProjects: () => [project],
		});

		const agents = service.listAgentsInProject(projectId);
		const child = agents.find((agent) => agent.id === "child-1");
		expect(child).toBeDefined();
		expect(child?.parentSessionId).toBe("parent-1");
		expect(child?.isSubagentSession).toBe(true);
		expect(child?.agentConfigName).toBe("Agent：review");
		expect(child?.lastActivityAt).toBeGreaterThan(0);

		// 二次调用命中 persistedInfoCache，标记不丢。
		const cached = service.listAgentsInProject(projectId).find((agent) => agent.id === "child-1");
		expect(cached?.parentSessionId).toBe("parent-1");
		expect(cached?.isSubagentSession).toBe(true);
	});

	it("falls back to persisted markers when the registry is empty and no runtime is live", async () => {
		const projectId = "proj-info-parent-2";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-info-cwd-"));
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };
		writeSubsession(projectId, "child.jsonl");

		const catalog = new SessionCatalog();
		await catalog.refresh(project);

		const service = new SessionInfoService({
			runtimeRegistry: { get: () => undefined, entries: () => new Map().entries() },
			sessionCatalog: catalog,
			subAgentRegistry: new SubAgentRegistry(), // 从未注册过
			scopeRegistry: { get: () => undefined },
			maxNameLength: 120,
			listProjects: () => [project],
		});

		const child = service.getAgentInfo("child-1");
		expect(child?.parentSessionId).toBe("parent-1");
		expect(child?.isSubagentSession).toBe(true);
	});

	it("keeps parentSessionId while the child is live even when the catalog has not discovered it yet", async () => {
		// 回归：子会话创建（runSubSession）时不会触发 sessionCatalog.refresh，
		// catalog 尚未收录该子会话（catalog.get(childId) === undefined），
		// 但 SubAgentRegistry 已注册父子关系。此时 runtimeInfo 投影出的
		// AgentInfo 仍必须带 parentSessionId，侧栏才能把运行中的子会话
		// 显示为子会话而不是顶层父会话。
		const projectId = "proj-info-parent-3";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-info-cwd-"));
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };
		const childId = "child-live-1";

		const catalog = new SessionCatalog(); // 从未 refresh → catalog 不含子会话
		const registry = new SubAgentRegistry();
		registry.register("parent-1", childId, "Agent：review");

		const session = {
			sessionManager: { getSessionName: () => "Agent：review" },
			getSessionStats: () => ({ totalMessages: 1 }),
			model: null,
			thinkingLevel: "off",
			supportsThinking: () => false,
			getAvailableThinkingLevels: () => ["off"],
			isStreaming: true,
			isRetrying: false,
			isCompacting: false,
			getContextUsage: () => undefined,
			sessionFile: undefined,
		};
		const managed = {
			runtime: { session },
			projectId,
			createdAt: 123,
		};
		const runtimeMap = new Map<string, typeof managed>([[childId, managed]]);

		const service = new SessionInfoService({
			runtimeRegistry: {
				get: (id: string) => (id === childId ? managed : undefined),
				entries: () => runtimeMap.entries(),
			},
			sessionCatalog: catalog,
			subAgentRegistry: registry,
			scopeRegistry: { get: () => undefined },
			maxNameLength: 120,
			listProjects: () => [project],
		});

		const agents = service.listAgentsInProject(projectId);
		const child = agents.find((agent) => agent.id === childId);
		expect(child).toBeDefined();
		expect(child?.parentSessionId).toBe("parent-1");
		expect(child?.isSubagentSession).toBe(true);
		expect(child?.agentConfigName).toBe("Agent：review");

		// 单个查询路径（getAgentInfo → runtimeInfo）同样校验内容变更时间投影。
		const direct = service.getAgentInfo(childId);
		expect(direct?.parentSessionId).toBe("parent-1");
		expect(direct?.isSubagentSession).toBe(true);
		expect(direct?.lastActivityAt).toBeGreaterThan(0);
	});
});
