// ============================================================
// ParallelRunStore — 并行子会话 run 的进程内状态存储
//
// subagent_parallel 的"总指挥模式"支撑：
//   - run 第一次调用创建，后续调用携带同一 runId 轮询续等
//   - 每个 task 持有独立 AbortController，支持 subagent_cancel
//     单独取消某个子会话或整批取消
//   - 完成/取消后保留一段时间供 subagent_status 查询，再 TTL 清理
//
// 与 SubAgentRegistry 的关系：registry 管父子会话生命周期（pending/
// 结果结算），store 只管"一批并行任务的执行状态视图"。二者不重叠。
// ============================================================

import { randomUUID } from "node:crypto";
import type { SubagentProgress, SubagentResult, SubagentTaskItem } from "./types.js";

/** 单个并行任务在 run 内的状态 */
export interface ParallelRunTaskState {
	/** 任务定义（agent/task/title） */
	task: SubagentTaskItem;
	/** 任务级取消控制器：subagent_cancel 通过它单独 abort */
	controller: AbortController;
	/** 子会话 pi session ID（启动后填充） */
	childSessionId?: string;
	/** 最新进度快照（subagent_status 展示运行中任务的实时信息） */
	lastProgress?: SubagentProgress;
	/** 最终结果（完成后填充） */
	result?: SubagentResult;
}

/** 一批并行任务的执行状态 */
export interface ParallelRun {
	runId: string;
	parentSessionId: string;
	toolCallId: string;
	createdAt: number;
	tasks: ParallelRunTaskState[];
	/** 是否已全部结算（完成/失败/取消） */
	settled: boolean;
	/** 全部结算的时间（TTL 清理起点） */
	settledAt?: number;
	/** worker 全部结束的 promise（首轮调用创建，续等轮询 await 它） */
	settlePromise?: Promise<void>;
}

const RUN_TTL_MS = 30 * 60 * 1000;
/** 未结算 run 的最大驻留时间：即使任务永不 settle（如子会话挂死），也强制清理。 */
const RUN_MAX_RESIDENCY_MS = 60 * 60 * 1000;

/** 单例 store：runId → ParallelRun */
class ParallelRunStore {
	private readonly runs = new Map<string, ParallelRun>();
	private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();

	create(parentSessionId: string, toolCallId: string, tasks: SubagentTaskItem[]): ParallelRun {
		const run: ParallelRun = {
			runId: randomUUID(),
			parentSessionId,
			toolCallId,
			createdAt: Date.now(),
			tasks: tasks.map((task) => ({ task, controller: new AbortController() })),
			settled: false,
		};
		this.runs.set(run.runId, run);
		// 未结算兜底：超过最大驻留时间强制清理（含 abort 未生效的挂死任务）
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(run.runId);
			this.cancelAll(run.runId);
			this.delete(run.runId);
		}, RUN_MAX_RESIDENCY_MS);
		timer.unref?.();
		this.cleanupTimers.set(run.runId, timer);
		return run;
	}

	get(runId: string): ParallelRun | undefined {
		return this.runs.get(runId);
	}

	/** 查找某父会话最近一次创建的 run（无 runId 时兜底展示用）。 */
	getLatestForParent(parentSessionId: string): ParallelRun | undefined {
		let latest: ParallelRun | undefined;
		for (const run of this.runs.values()) {
			if (run.parentSessionId !== parentSessionId) continue;
			if (!latest || run.createdAt > latest.createdAt) latest = run;
		}
		return latest;
	}

	/** 列出全部 run（调试/测试用）。 */
	listAll(): ParallelRun[] {
		return Array.from(this.runs.values());
	}

	/** 记录子会话启动信息。 */
	setChildSessionId(runId: string, index: number, childSessionId: string): void {
		const run = this.runs.get(runId);
		if (!run || !run.tasks[index]) return;
		run.tasks[index].childSessionId = childSessionId;
	}

	/** 更新任务进度快照（subagent_status 读取）。 */
	updateProgress(runId: string, index: number, progress: SubagentProgress): void {
		const run = this.runs.get(runId);
		if (!run || !run.tasks[index]) return;
		run.tasks[index].lastProgress = progress;
	}

	/** 写入任务最终结果；全部结算时标记 settled 并启动 TTL 清理。 */
	setResult(runId: string, index: number, result: SubagentResult): void {
		const run = this.runs.get(runId);
		if (!run || !run.tasks[index]) return;
		run.tasks[index].result = result;
		run.tasks[index].childSessionId = result.sessionId || run.tasks[index].childSessionId;
		if (!run.settled && run.tasks.every((t) => t.result !== undefined)) {
			run.settled = true;
			run.settledAt = Date.now();
			// 取消驻留兜底 timer，改为结算后的 TTL 清理
			const residencyTimer = this.cleanupTimers.get(runId);
			if (residencyTimer) {
				clearTimeout(residencyTimer);
				this.cleanupTimers.delete(runId);
			}
			this.scheduleCleanup(runId);
		}
	}

	/** 取消 run 中指定索引的任务（subagent_cancel 单任务取消）。 */
	cancelTask(runId: string, index: number): boolean {
		const run = this.runs.get(runId);
		if (!run || !run.tasks[index]) return false;
		if (run.tasks[index].controller.signal.aborted) return false;
		run.tasks[index].controller.abort();
		return true;
	}

	/** 取消整个 run 中所有未结算任务，返回取消数量。 */
	cancelAll(runId: string): number {
		const run = this.runs.get(runId);
		if (!run) return 0;
		let cancelled = 0;
		for (const task of run.tasks) {
			if (task.controller.signal.aborted) continue;
			task.controller.abort();
			cancelled++;
		}
		return cancelled;
	}

	/** 删除 run（显式清理；TTL 自动清理走 scheduleCleanup）。 */
	delete(runId: string): void {
		const timer = this.cleanupTimers.get(runId);
		if (timer) {
			clearTimeout(timer);
			this.cleanupTimers.delete(runId);
		}
		this.runs.delete(runId);
	}

	private scheduleCleanup(runId: string): void {
		const timer = setTimeout(() => this.delete(runId), RUN_TTL_MS);
		timer.unref?.();
		this.cleanupTimers.set(runId, timer);
	}
}

/** 全局单例。 */
export const parallelRunStore = new ParallelRunStore();
