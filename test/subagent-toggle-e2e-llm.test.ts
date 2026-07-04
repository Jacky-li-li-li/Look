// ============================================================
// Stage 2 真实 LLM E2E：验证开关关闭时 LLM 无法调用 subagent
//（subagent 工具被移除，LLM 看不到它，无法创建子会话）。
// 开关打开路径已由 Stage 1 E2E + API 诊断验证，此处不重复。
// 受 LOOK_E2E_LLM 环境变量守护。
// ============================================================

import { describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session/runtime-manager.js";

const RUN = process.env.LOOK_E2E_LLM === "1";
const TIMEOUT = 180_000;

function waitForEnd(manager: SessionRuntimeManager, parentId: string, timeout: number) {
	return new Promise<{ children: number; errors: string[] }>((resolve) => {
		let onTurnEnd: (() => void) | undefined;
		const turnEnded = new Promise<void>((r) => (onTurnEnd = r));
		const errors: string[] = [];
		const unsubscribe = manager.onEvent((event) => {
			if (event.type === "error") errors.push(event.message);
			if (event.type === "session:snapshot" && event.sessionId === parentId && event.reason === "agent_end") {
				onTurnEnd?.();
			}
		});
		Promise.race([
			turnEnded,
			new Promise<void>((r) => setTimeout(r, timeout)),
		]).then(() => {
			unsubscribe();
			const children = manager.listSubSessions(parentId);
			resolve({ children: children.length, errors });
		});
	});
}

describe.skipIf(!RUN)("SubAgent toggle real-LLM E2E", () => {
	it(
		"关闭开关 → LLM 看不到 subagent 工具 → 不创建子会话",
		async () => {
			const manager = new SessionRuntimeManager();
			await manager.loadProjects();
			const projects = manager.listProjects();
			const project = projects.find((p) => p.valid && p.name === "pi") ?? projects.find((p) => p.valid);
			expect(project).toBeTruthy();
			await manager.setActiveProject(project!.id);

			// ── 关闭开关 ──
			await manager.setSubagentEnabledGlobal(false);

			// ── 验证：新会话没有 subagent 工具 ──
			const diagId = await manager.createAgent({ name: "toggle-diag" });
			const managed = Array.from(
				(manager as any).runtimes?.entries() ?? [],
			).find(([sid]: [string, unknown]) => sid === diagId)?.[1] as any;
			const hasSubagent = managed
				? managed.runtime.session.getActiveToolNames().includes("subagent")
				: "unknown";
			expect(hasSubagent, "toggle OFF 时 subagent 不应在活动工具中").toBe(false);
			await manager.destroyAgent(diagId).catch(() => {});

			// ── LLM E2E：发消息指令调用 subagent，LM 应该自己完成任务（无子会话） ──
			const id = await manager.createAgent({ name: "toggle-off-e2e" });
			const sessionModel = manager.getAgentInfo(id)?.model || "unknown";
			console.log(`[TOGGLE-E2E] session ${id}, model=${sessionModel}, toggle=OFF`);

			try {
				await manager.sendMessage(
					id,
					[
						"请用 scout subagent 帮我找到项目根目录下的所有文件。参数：agent=scout, task=用 ls 列项目根目录。",
						"如果你看不到 subagent 工具，就自己用 ls 完成，然后说明 subagent 工具不可用。",
					].join("\n"),
				);
				const result = await waitForEnd(manager, id, TIMEOUT);
				await new Promise((r) => setTimeout(r, 500));
				console.log(`[TOGGLE-E2E] children=${result.children}, errors=${result.errors.length}`);
				expect(result.children, "开关关闭时 LLM 不应能创建子会话").toBe(0);
			} finally {
				await manager.destroyAgent(id).catch(() => {});
			}

			// 恢复默认
			await manager.setSubagentEnabledGlobal(true);
		},
		TIMEOUT + 30_000,
	);

	it(
		"Stage 1 验证回顾：开关打开时 LLM 可以调用 subagent（API 级确认）",
		async () => {
			// 仅做 API 级确认，LLM 实际调用已在 Stage 1 E2E 验证。
			const manager = new SessionRuntimeManager();
			await manager.loadProjects();
			const project = manager.listProjects().find((p) => p.valid);
			expect(project).toBeTruthy();
			await manager.setActiveProject(project!.id);
			await manager.setSubagentEnabledGlobal(true);

			const id = await manager.createAgent({ name: "toggle-on-api" });
			const managed = Array.from(
				(manager as any).runtimes?.entries() ?? [],
			).find(([sid]: [string, unknown]) => sid === id)?.[1] as any;
			const hasSubagent = managed
				? managed.runtime.session.getActiveToolNames().includes("subagent")
				: false;
			expect(hasSubagent, "toggle ON 时 subagent 应在活动工具中").toBe(true);

			await manager.destroyAgent(id).catch(() => {});
		},
		30_000,
	);
});
