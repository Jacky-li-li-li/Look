// ============================================================
// agent-runner 总指挥模式测试：部分完成 → 续等 → 全部结算/取消
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runParallelAgents } from "../src/main/extensions/subagent/agent-runner";
import { parallelRunStore } from "../src/main/extensions/subagent/parallel-run-store";
import type { AgentConfig, SubagentHost, SubagentResult } from "../src/main/extensions/subagent/types";
import { zeroUsage } from "../src/main/extensions/subagent/types";

const AGENTS: AgentConfig[] = [
	{
		name: "scout",
		title: "Scout",
		description: "test agent",
		source: "user",
		filePath: "/tmp/test-agent.md",
		systemPrompt: "",
	},
];

/** 可控 host：每个 runSubSession 挂在一个 deferred 上，测试手动 resolve。 */
function createDeferredHost(settle: (index: number, result: SubagentResult) => void) {
	const callbacks = new Map<number, (result: SubagentResult) => void>();
	const host: SubagentHost = {
		discoverAgents: async () => ({ agents: AGENTS, projectAgentsDir: null }),
		isSubagentEnabled: () => true,
		runSubSession: (_parent, _agent, _task, signal, _title) => {
			const index = callbacks.size;
			// 模拟真实链路（session-subagent-service.runSubSession）的 fail-fast：
			// signal 已中止时立即返回 aborted，不再创建子会话
			if (signal?.aborted) {
				return Promise.resolve({
					sessionId: `child-${index}`,
					agentName: "scout",
					agentSource: "user",
					task: _task,
					status: "aborted",
					finalOutput: "",
					usage: zeroUsage(),
					errorMessage: "aborted before start",
				});
			}
			return new Promise<SubagentResult>((resolve) => {
				callbacks.set(index, resolve);
				signal?.addEventListener(
					"abort",
					() => {
						resolve({
							sessionId: `child-${index}`,
							agentName: "scout",
							agentSource: "user",
							task: _task,
							status: "aborted",
							finalOutput: "",
							usage: zeroUsage(),
							errorMessage: "cancelled",
						});
					},
					{ once: true },
				);
			});
		},
	};
	settle = (index: number, result: SubagentResult) => {
		callbacks.get(index)?.(result);
	};
	return { host, settle };
}

function completedResult(index: number): SubagentResult {
	return {
		sessionId: `child-${index}`,
		agentName: "scout",
		agentSource: "user",
		task: `task ${index}`,
		status: "completed",
		finalOutput: `output ${index}`,
		usage: zeroUsage(),
	};
}

const TASKS = [
	{ agent: "scout", task: "task 0", title: "T0" },
	{ agent: "scout", task: "task 1", title: "T1" },
	{ agent: "scout", task: "task 2", title: "T2" },
];

describe("runParallelAgents — 总指挥模式", () => {
	let host: SubagentHost;
	let settle: (index: number, result: SubagentResult) => void;

	beforeEach(() => {
		const created = createDeferredHost(() => {});
		host = created.host;
		settle = created.settle;
	});

	afterEach(() => {
		for (const run of parallelRunStore.listAll()) parallelRunStore.delete(run.runId);
	});

	it("等待 maxWaitMs 到点返回部分结果 + pending（不判死）", async () => {
		const waitPromise = runParallelAgents(host, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			maxWaitMs: 100,
		});
		// 立即结算前两个任务，第三个保持 pending
		settle(0, completedResult(0));
		settle(1, completedResult(1));

		const snapshot = await waitPromise;
		expect(snapshot.results).toHaveLength(2);
		expect(snapshot.pending).toHaveLength(1);
		expect(snapshot.total).toBe(3);
		expect(snapshot.settled).toBe(false);
		expect(snapshot.results[0].status).toBe("completed");
		expect(snapshot.pending[0]).toMatchObject({ index: 2 });
	});

	it("携带 runId 续等可拿到剩余结果", async () => {
		const firstPromise = runParallelAgents(host, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			maxWaitMs: 100,
		});
		settle(0, completedResult(0));
		const first = await firstPromise;
		expect(first.results).toHaveLength(1);
		expect(first.pending).toHaveLength(2);
		expect(first.pending.map((p) => p.index)).toEqual([1, 2]);

		// 续等：同一 runId，等待剩余任务完成
		settle(1, completedResult(1));
		settle(2, completedResult(2));
		const second = await runParallelAgents(host, "parent-1", AGENTS, [], undefined, "call-2", undefined, {
			runId: first.runId,
			maxWaitMs: 100,
		});
		expect(second.results).toHaveLength(3);
		expect(second.pending).toHaveLength(0);
		expect(second.settled).toBe(true);
	});

	it("父会话 signal 中止时 queued 任务不再启动（P1-2 场景）", async () => {
		const controller = new AbortController();
		controller.abort(); // 父 signal 在启动前已中止
		const snapshot = await runParallelAgents(
			host,
			"parent-1",
			AGENTS,
			TASKS,
			controller.signal,
			"call-1",
			undefined,
			{
				maxWaitMs: 200,
			},
		);
		// 所有任务都应被立即标记 aborted（无子会话实际启动），run 已 settle
		expect(snapshot.settled).toBe(true);
		expect(snapshot.results).toHaveLength(3);
		expect(snapshot.results.every((r) => r.status === "aborted")).toBe(true);
	});

	it("全部任务失败时 run 正常 settle", async () => {
		const failingHost: SubagentHost = {
			discoverAgents: async () => ({ agents: AGENTS, projectAgentsDir: null }),
			isSubagentEnabled: () => true,
			runSubSession: async () => {
				throw new Error("boom");
			},
		};
		const snapshot = await runParallelAgents(failingHost, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			maxWaitMs: 200,
		});
		expect(snapshot.settled).toBe(true);
		expect(snapshot.results).toHaveLength(3);
		expect(snapshot.results.every((r) => r.status === "failed")).toBe(true);
		expect(snapshot.results[0].errorMessage).toBe("boom");
	});

	it("未知 runId 时新建 run（不卡死）", async () => {
		const snapshot = await runParallelAgents(host, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			runId: "unknown-run-id",
			maxWaitMs: 200,
		});
		expect(snapshot.runId).not.toBe("unknown-run-id");
		expect(snapshot.total).toBe(3);
	});

	it("cancelAll 取消全部任务并正常 settle", async () => {
		const first = await runParallelAgents(host, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			maxWaitMs: 100,
		});
		expect(first.pending).toHaveLength(3);
		const count = parallelRunStore.cancelAll(first.runId);
		expect(count).toBe(3);

		const second = await runParallelAgents(host, "parent-1", AGENTS, [], undefined, "call-2", undefined, {
			runId: first.runId,
			maxWaitMs: 100,
		});
		expect(second.settled).toBe(true);
		expect(second.results.filter((r) => r.status === "aborted")).toHaveLength(3);
	});

	it("subagent_cancel 单独取消一个任务，其余继续", async () => {
		const first = await runParallelAgents(host, "parent-1", AGENTS, TASKS, undefined, "call-1", undefined, {
			maxWaitMs: 100,
		});
		expect(first.pending).toHaveLength(3);

		const cancelled = parallelRunStore.cancelTask(first.runId, 0);
		expect(cancelled).toBe(true);

		settle(1, completedResult(1));
		settle(2, completedResult(2));
		const second = await runParallelAgents(host, "parent-1", AGENTS, [], undefined, "call-2", undefined, {
			runId: first.runId,
			maxWaitMs: 100,
		});
		expect(second.settled).toBe(true);
		const aborted = second.results.find((r) => r.task === "task 0");
		expect(aborted?.status).toBe("aborted");
		expect(second.results.filter((r) => r.status === "completed")).toHaveLength(2);
	});
});
