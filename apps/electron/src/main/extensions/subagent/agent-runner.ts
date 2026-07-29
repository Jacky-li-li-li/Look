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
 * 并发上限可通过环境变量 LOOK_MAX_CONCURRENT_SUBAGENTS 覆盖，
 * 默认值为 5。
 */
export async function runParallelAgents(
	host: SubagentHost,
	parentSessionId: string,
	agents: AgentConfig[],
	tasks: SubagentTaskItem[],
	signal: AbortSignal | undefined,
	toolCallId: string,
	onUpdate?: (progress: SubagentProgress) => void,
): Promise<SubagentResult[]> {
	const maxConcurrent = (() => {
		const env = Number.parseInt(process.env.LOOK_MAX_CONCURRENT_SUBAGENTS ?? "", 10);
		return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_CONCURRENT_SUBAGENTS;
	})();

	// 并发池：信号量计数 + 结果收集
	const results: SubagentResult[] = new Array(tasks.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (nextIndex < tasks.length) {
			const i = nextIndex++;
			const t = tasks[i];
			try {
				results[i] = await runSingleAgent(
					host,
					parentSessionId,
					agents,
					t.agent,
					t.task,
					signal,
					t.title,
					toolCallId,
					onUpdate,
				);
			} catch (error) {
				results[i] = {
					sessionId: "",
					agentName: t.agent,
					agentSource: "user",
					task: t.task,
					status: "failed",
					finalOutput: `Parallel subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: error instanceof Error ? error.message : String(error),
				};
			}
		}
	}

	// 启动并发池（maxConcurrent 个 worker）
	const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, () => runNext());
	await Promise.all(workers);
	return results;
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
