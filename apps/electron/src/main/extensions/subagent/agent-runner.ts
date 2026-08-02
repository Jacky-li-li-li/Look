// ============================================================
// SubAgent Extension — Agent 执行引擎
//
// 三种执行模式（与 SDK 示例对齐）：
//   - single:  单个子会话
//   - parallel: 并发池限制（默认 5），防止无限制创建子会话导致
//     API rate limit 和主进程内存峰值。
//   - chain:   顺序执行，{previous} 占位符替换为上一步输出
//
// 与 SDK 示例的关键区别：不通过 child_process.spawn 子进程，
// 而是通过 SubagentHost.runSubSession 创建完整的 Look 子会话
// （SessionRuntimeManager 生命周期），子会话侧边栏可见、可持久化。
// ============================================================

import { type ParallelRun, parallelRunStore } from "./parallel-run-store.js";
import type {
	AgentConfig,
	SubagentChainItem,
	SubagentHost,
	SubagentProgress,
	SubagentResult,
	SubagentTaskItem,
} from "./types.js";

/** 默认并行子会话上限。每个子会话消耗 ~50-200MB 内存和独立 LLM 连接。 */
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 5;
/** 并行 run 单次等待上限（汇报点，不判死）。可用环境变量覆盖。 */
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

/** 并行 run 的等待/恢复选项 */
export interface ParallelRunOptions {
	/** 已有 run 的 ID：传入后不新建任务，而是续等同一批任务的剩余结果 */
	runId?: string;
	/** 单次等待上限 ms：到点返回部分结果 + pending 清单，而非判死。缺省 5 分钟 */
	maxWaitMs?: number;
}

/** 并行 run 的一次快照（已完成结果 + 未完成清单） */
export interface ParallelRunSnapshot {
	runId: string;
	/** 已结算的全部结果（含之前轮询已返回的） */
	results: SubagentResult[];
	/** 仍在运行/未结算的任务（携带原始 taskIndex，供 cancel/编号对齐） */
	pending: Array<{ task: SubagentTaskItem; index: number }>;
	total: number;
	/** 是否已全部结算 */
	settled: boolean;
}

function resolveMaxWaitMs(options?: ParallelRunOptions): number {
	if (options?.maxWaitMs !== undefined && Number.isFinite(options.maxWaitMs) && options.maxWaitMs > 0) {
		return options.maxWaitMs;
	}
	const env = Number.parseInt(process.env.LOOK_SUBAGENT_MAX_WAIT_MS ?? "", 10);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_WAIT_MS;
}

/** 在已发现列表中按名查找 Agent */
function resolveAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((a) => a.name === name);
}

/** 未知 Agent 的标准错误结果 */
function unknownAgentResult(name: string, task: string, agents: AgentConfig[]): SubagentResult {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		sessionId: "",
		agentName: name,
		agentSource: "user",
		task,
		status: "failed",
		finalOutput: `Unknown agent: "${name}". Available agents: ${available}.`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage: `Unknown agent: ${name}`,
	};
}

/** 执行单个子会话 */
export async function runSingleAgent(
	host: SubagentHost,
	parentSessionId: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	signal: AbortSignal | undefined,
	title: string,
	toolCallId: string,
	onUpdate?: (progress: SubagentProgress) => void,
	step?: number,
): Promise<SubagentResult> {
	const agent = resolveAgent(agents, agentName);
	if (!agent) return unknownAgentResult(agentName, task, agents);
	const result = await host.runSubSession(parentSessionId, agent, task, signal, title, toolCallId, title, onUpdate);
	if (step !== undefined) result.step = step;
	return result;
}

/**
 * 并发执行多个子会话。使用信号量限制并行数，防止无限制创建
 * 子会话导致 API rate limit 和主进程内存峰值。
 *
 * 并发上限可通过环境变量 LOOK_MAX_CONCURRENT_SUBAGENTS 覆盖，默认 5。
 *
 * 总指挥模式：不设硬超时判死。每次调用最多等待 maxWaitMs（缺省 5 分钟），
 * 到点返回已完成结果 + 仍在运行的任务清单（连同 runId）；父会话可携带同一
 * runId 再次调用本函数续等剩余任务，或通过 subagent_status / subagent_cancel
 * 查询/取消。任务级 AbortController 支持单独取消。
 */
export async function runParallelAgents(
	host: SubagentHost,
	parentSessionId: string,
	agents: AgentConfig[],
	tasks: SubagentTaskItem[],
	signal: AbortSignal | undefined,
	toolCallId: string,
	onUpdate?: (progress: SubagentProgress) => void,
	options?: ParallelRunOptions,
): Promise<ParallelRunSnapshot> {
	const maxConcurrent = (() => {
		const env = Number.parseInt(process.env.LOOK_MAX_CONCURRENT_SUBAGENTS ?? "", 10);
		return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_CONCURRENT_SUBAGENTS;
	})();
	const maxWaitMs = resolveMaxWaitMs(options);

	// 已有 run → 续等模式：不新建任务，只等待剩余结果（workers 仍在后台跑）
	const existing = options?.runId ? parallelRunStore.get(options.runId) : undefined;
	if (existing) {
		if (existing.settled) return snapshot(existing);
		await waitForSettlement(existing, maxWaitMs, signal);
		return snapshot(existing);
	}

	// 新建 run
	const run = parallelRunStore.create(parentSessionId, toolCallId, tasks);
	if (options?.runId) {
		// 调用方传了未知 runId：仍允许新建（视为新一批），避免父会话因 ID 失效卡死。
		console.warn(`[SubAgent] runId ${options.runId} not found; starting new run ${run.runId}`);
	}

	// 并发池 worker：从 run 中逐个取任务执行，结果/进度写入 store
	const store = parallelRunStore;
	let nextIndex = 0;
	async function runNext(): Promise<void> {
		while (nextIndex < run.tasks.length) {
			const index = nextIndex++;
			await runTask(run, index, signal);
		}
	}

	async function runTask(runRef: ParallelRun, index: number, parentSignal: AbortSignal | undefined): Promise<void> {
		const t = runRef.tasks[index];
		const taskDef = t.task;
		// 任务级 signal：父会话 abort → 级联 abort；subagent_cancel 单独 abort
		// 先检查父 signal 是否已中止：已中止则 queued 任务不得再启动（否则出现孤儿子会话）
		if (parentSignal?.aborted) {
			t.controller.abort();
		}
		const onParentAbort = () => t.controller.abort();
		parentSignal?.addEventListener("abort", onParentAbort, { once: true });
		try {
			const result = await runSingleAgent(
				host,
				runRef.parentSessionId,
				agents,
				taskDef.agent,
				taskDef.task,
				t.controller.signal,
				taskDef.title,
				toolCallId,
				(progress) => {
					store.updateProgress(runRef.runId, index, progress);
					onUpdate?.(progress);
				},
			);
			store.setResult(runRef.runId, index, result);
		} catch (error) {
			store.setResult(runRef.runId, index, {
				sessionId: t.childSessionId ?? "",
				agentName: taskDef.agent,
				agentSource: "user",
				task: taskDef.task,
				status: t.controller.signal.aborted ? "aborted" : "failed",
				finalOutput: `Parallel subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		} finally {
			parentSignal?.removeEventListener("abort", onParentAbort);
		}
	}

	// 保存 settle promise 到 run：worker 全部结束 → 结算（供续等轮询 await）
	const workers = Array.from({ length: Math.min(maxConcurrent, run.tasks.length) }, () => runNext());
	run.settlePromise = Promise.all(workers).then(
		() => undefined,
		() => undefined,
	);

	await waitForSettlement(run, maxWaitMs, signal);
	return snapshot(run);
}

/**
 * 等待 run 全部结算，或到达 maxWaitMs 汇报点（不判死）。
 * 父会话 signal 中止时提前返回。
 */
async function waitForSettlement(run: ParallelRun, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, maxWaitMs);
		timer.unref?.();
	});
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		onAbort = () => resolve();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	await Promise.race([run.settlePromise ?? Promise.resolve(), timeout, aborted]);
	// 清理：避免多次续等累积 timer 与 listener
	if (timer) clearTimeout(timer);
	if (onAbort) signal?.removeEventListener("abort", onAbort);
}

/** 生成当前 run 快照。 */
function snapshot(run: ParallelRun): ParallelRunSnapshot {
	const results: SubagentResult[] = [];
	const pending: Array<{ task: SubagentTaskItem; index: number }> = [];
	run.tasks.forEach((t, index) => {
		if (t.result) results.push(t.result);
		else pending.push({ task: t.task, index });
	});
	return {
		runId: run.runId,
		results,
		pending,
		total: run.tasks.length,
		settled: run.settled,
	};
}

/**
 * 顺序执行子会话链。每一步的 task 中的 {previous} 占位符会被
 * 替换为上一步的 finalOutput。任一步失败则停止整条链。
 *
 * 返回所有已完成步骤的结果与停止位置。
 */
export async function runChainAgents(
	host: SubagentHost,
	parentSessionId: string,
	agents: AgentConfig[],
	chain: SubagentChainItem[],
	signal: AbortSignal | undefined,
	toolCallId: string,
	onUpdate?: (progress: SubagentProgress) => void,
): Promise<{ results: SubagentResult[]; stoppedAtStep?: number }> {
	const results: SubagentResult[] = [];
	let previousOutput = "";
	for (let i = 0; i < chain.length; i++) {
		const item = chain[i];
		const taskWithContext = item.task.replace(/\{previous\}/g, previousOutput);
		// react-doctor-disable-next-line async-await-in-loop -- 子会话链必须顺序执行，下一步依赖上一步输出
		const result = await runSingleAgent(
			host,
			parentSessionId,
			agents,
			item.agent,
			taskWithContext,
			signal,
			item.title,
			toolCallId,
			onUpdate,
			i + 1,
		);
		results.push(result);
		if (result.status !== "completed") {
			return { results, stoppedAtStep: i + 1 };
		}
		previousOutput = result.finalOutput;
	}
	return { results };
}
