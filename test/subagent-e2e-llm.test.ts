// ============================================================
// SubAgent 真实 LLM 端到端验证（受 LOOK_E2E_LLM 环境变量守护）
//
// 仅当 LOOK_E2E_LLM=1 时运行：构造真实 SessionRuntimeManager，
// 在已配置的项目中创建会话，指示 LLM 调用 subagent 工具，
// 验证子会话被真实创建并落盘到 subsessions/ 目录。
//
// 会消耗真实 LLM token；运行前确保已配置 provider API Key。
// ============================================================

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session/runtime-manager.js";
import { getWorkspaceSubsessionsDir } from "@shared/look-storage";

const RUN = process.env.LOOK_E2E_LLM === "1";
const TIMEOUT = 240_000; // 父+子 LLM 调用，给足 4 分钟

describe.skipIf(!RUN)("SubAgent real-LLM E2E", () => {
	it(
		"LLM 调用 subagent 工具 → 创建真实子会话并落盘",
		async () => {
			const manager = new SessionRuntimeManager();
			await manager.loadProjects();

			// 选一个有效的项目（优先 pi，含认证代码便于 scout 测试）
			const projects = manager.listProjects();
			const project = projects.find((p) => p.valid && p.name === "pi") ?? projects.find((p) => p.valid);
			expect(project, "需要一个有效项目").toBeTruthy();
			await manager.setActiveProject(project!.id);

			const subsessionsDir = getWorkspaceSubsessionsDir(project!.name);
			const beforeFiles = new Set(existsSync(subsessionsDir) ? readdirSync(subsessionsDir) : []);

			let parentId: string | undefined;
			try {
				parentId = await manager.createAgent({ name: "subagent-e2e" });
				console.log(`[E2E] parent session: ${parentId}`);

				// 监听事件：记录 subagent 活动 + 捕获错误 + 等待父会话 agent_end
				const events: string[] = [];
				const errors: string[] = [];
				let onTurnEnd: (() => void) | undefined;
				const turnEnded = new Promise<void>((resolve) => {
					onTurnEnd = resolve;
				});
				const unsubscribe = manager.onEvent((event) => {
					if (event.type === "error" && (!event.agentId || event.agentId === parentId)) {
						errors.push(event.message);
						console.log(`[E2E][ERR] ${event.message}`);
					}
					if (event.type === "session:subagent-progress") {
						events.push(`progress:${event.agentName}`);
						console.log(`[E2E][PROGRESS] ${event.agentName} turns=${event.usage.turns}`);
					}
					if (event.type === "session:subagent-completed") {
						events.push(`completed:${event.agentName}:${event.result.status}`);
						console.log(`[E2E][COMPLETED] ${event.agentName} status=${event.result.status}`);
					}
					// 父会话回合结束信号
					if (event.type === "session:snapshot" && event.sessionId === parentId && event.reason === "agent_end") {
						console.log("[E2E] parent agent_end received");
						onTurnEnd?.();
					}
				});

				// 用一个轻量任务让 scout 快速完成（避免在大仓库里长时间搜索）
				const instruction = [
					"请调用 subagent 工具（single 模式）完成下面这个简单任务：",
					'用 agent="scout", task="用 ls 工具列出当前项目根目录下的文件和目录名，然后用一句话总结这个项目的结构。"',
					"直接调用 subagent 工具即可，不要自己用 ls。",
					"拿到 scout 的结果后，用一句话复述 scout 说了什么。",
				].join("\n");
				await manager.sendMessage(parentId, instruction);
				console.log("[E2E] message sent, waiting for turn to complete...");

				// 等待父会话 agent_end（事件驱动），超时兜底
				await Promise.race([turnEnded, new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT))]);
				// 给最终事件（subagent-completed 可能略晚于父 agent_end）一点余量
				await new Promise((r) => setTimeout(r, 1500));
				unsubscribe();
				console.log(`[E2E] turn finished, events=${events.join(", ") || "(none)"}, errors=${errors.length}`);

				// 断言 1：子会话被创建（listSubSessions 非空）
				const children = manager.listSubSessions(parentId);
				console.log(`[E2E] child sessions: ${children.length} → ${children.join(", ")}`);
				expect(children.length, "LLM 应调用 subagent 并创建子会话").toBeGreaterThan(0);

				// 断言 2：subsessions/ 目录有新 .jsonl 落盘
				await new Promise((r) => setTimeout(r, 500)); // 等落盘
				const afterFiles = existsSync(subsessionsDir) ? readdirSync(subsessionsDir) : [];
				const newFiles = afterFiles.filter((f) => !beforeFiles.has(f));
				console.log(`[E2E] new subsession files: ${newFiles.join(", ") || "(none)"}`);
				expect(newFiles.length, "子会话应持久化到 subsessions/ 目录").toBeGreaterThan(0);

				// 断言 3：父会话感知到 subagent-completed 事件
				expect(
					events.some((e) => e.startsWith("completed:")),
					"应收到 session:subagent-completed 事件",
				).toBe(true);
			} finally {
				// 清理：销毁父会话会级联销毁子会话（destroySubSessions）
				if (parentId) {
					await manager.destroyAgent(parentId).catch((e) => console.warn("[E2E] cleanup failed:", e));
					console.log("[E2E] cleaned up parent + child sessions");
				}
			}
		},
		TIMEOUT + 30_000,
	);
});
