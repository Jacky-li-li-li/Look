// ============================================================
// SubAgent Extension — Agent 执行引擎
//
// 三种执行模式（与 SDK 示例对齐）：
//   - single:  单个子会话
//   - parallel: Promise.all 全并发（Stage 6 移除数量限制）
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
	onUpdate?: (progress: SubagentProgress) => void,
	step?: number,
	title?: string,
): Promise<SubagentResult> {
	const agent = resolveAgent(agents, agentName);
	if (!agent) return unknownAgentResult(agentName, task, agents);
	const result = await host.runSubSession(parentSessionId, agent, task, signal, onUpdate, title);
	if (step !== undefined) result.step = step;
	return result;
}

/**
 * 并发执行多个子会话。使用 Promise.all 全并发，由操作系统资源
 * 自然限制（Stage 6：不再有 MAX_PARALLEL_TASKS / MAX_CONCURRENCY 上限）。
 */
export async function runParallelAgents(
	host: SubagentHost,
	parentSessionId: string,
	agents: AgentConfig[],
	tasks: SubagentTaskItem[],
	signal: AbortSignal | undefined,
	onUpdate?: (progress: SubagentProgress) => void,
): Promise<SubagentResult[]> {
	return Promise.all(
		tasks.map((t) =>
			runSingleAgent(host, parentSessionId, agents, t.agent, t.task, signal, onUpdate, undefined, t.title),
		),
	);
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
			onUpdate,
			i + 1,
			item.title,
		);
		results.push(result);
		if (result.status !== "completed") {
			return { results, stoppedAtStep: i + 1 };
		}
		previousOutput = result.finalOutput;
	}
	return { results };
}
