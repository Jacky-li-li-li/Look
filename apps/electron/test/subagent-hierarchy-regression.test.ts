// ============================================================
// Subagent hierarchy regression — runSubSession → agent:created
//
// 回归：子会话在 runSubSession 中创建时，sessionCatalog 尚未刷新
// （runSubSession 不触发 catalog refresh），但 SubAgentRegistry 已
// register 父子关系。此时 host.runtimeInfo() 通过 SessionInfoService
// 构建的 AgentInfo 必须仍带 parentSessionId / isSubagentSession，
// 否则 agent:created 事件载荷缺少父子标记，侧栏会把运行中的子会话
// 错误显示为顶层父会话（用户报告：生成时是父会话，完成后才变子会话）。
// ============================================================

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWorkspaceDir } from "@look/shared/look-storage";
import type { MainToRendererEvent, ProjectInfo } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../src/main/session/services/session-catalog.js";
import { SessionInfoService } from "../src/main/session/services/session-info-service.js";
import { SubAgentRegistry } from "../src/main/session/subagent-registry.js";

function makeLiveChildSession(childId: string) {
	return {
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
	} as never;
}

describe("subagent hierarchy: runSubSession → agent:created payload", () => {
	it("carries parentSessionId in agent:created even before the catalog is refreshed", async () => {
		const projectId = "proj-hierarchy-regression";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-hierarchy-cwd-"));
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };
		const childId = "child-hierarchy-1";
		const parentId = "parent-hierarchy-1";

		// runSubSession 会创建 subsessions 目录（但不触发 catalog refresh）。
		ensureWorkspaceDir(projectId);

		// 真实对象：catalog 从未 refresh → 不含子会话；
		// registry 已 register（模拟 runSubSession 中 register 早于 runtimeInfo）。
		const catalog = new SessionCatalog();
		const registry = new SubAgentRegistry();
		registry.register(parentId, childId, "Agent：review");

		// 子会话 runtime 已在运行时注册表中（live）。
		const childSession = makeLiveChildSession(childId);
		const managed = { runtime: { session: childSession }, projectId, createdAt: 123 };
		const runtimeMap = new Map<string, typeof managed>([[childId, managed]]);

		// 与 builder.ts 接线一致：host.runtimeInfo = sessionInfoService.getAgentInfo
		const sessionInfoService = new SessionInfoService({
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
		const hostRuntimeInfo = (sessionId: string) => sessionInfoService.getAgentInfo(sessionId);

		// 模拟 runSubSession 尾部：runtimeInfo → emit agent:created。
		const childInfo = hostRuntimeInfo(childId);
		expect(childInfo).toBeDefined();
		expect(childInfo?.parentSessionId).toBe(parentId);
		expect(childInfo?.isSubagentSession).toBe(true);

		const emitted: MainToRendererEvent[] = [];
		if (childInfo) {
			emitted.push({ type: "agent:created", agentId: childId, agent: childInfo });
		}
		const createdEvent = emitted.find(
			(event): event is Extract<MainToRendererEvent, { type: "agent:created" }> => event.type === "agent:created",
		);
		expect(createdEvent?.agent.parentSessionId).toBe(parentId);
		expect(createdEvent?.agent.isSubagentSession).toBe(true);
	});

	it("reports parentSessionId through getAgentInfo for a live child after catalog refresh", async () => {
		const projectId = "proj-hierarchy-refreshed";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-hierarchy-cwd-"));
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };
		const childId = "child-hierarchy-2";
		const parentId = "parent-hierarchy-2";

		const catalog = new SessionCatalog();
		await catalog.refresh(project); // catalog 已刷新
		const registry = new SubAgentRegistry();
		registry.register(parentId, childId, "Agent：review");

		const childSession = makeLiveChildSession(childId);
		const managed = { runtime: { session: childSession }, projectId, createdAt: 456 };
		const runtimeMap = new Map<string, typeof managed>([[childId, managed]]);

		const sessionInfoService = new SessionInfoService({
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

		const child = sessionInfoService.getAgentInfo(childId);
		expect(child?.parentSessionId).toBe(parentId);
		expect(child?.isSubagentSession).toBe(true);
	});
});
