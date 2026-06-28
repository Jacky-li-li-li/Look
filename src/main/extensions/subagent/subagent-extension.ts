// ============================================================
// SubAgent Extension — 扩展入口（ExtensionFactory）
//
// 注册 `subagent` 工具到 pi SDK。LLM 调用时按 mode 分发到
// agent-runner 的 single / parallel / chain 执行引擎，每个子会话
// 通过 SubagentHost.runSubSession 创建完整 Look 子会话。
//
// 注入点：SessionRuntimeManager.buildExtensionFactories()，与
// permission / plan 扩展同等的 ExtensionFactory 机制。
//
// Look 不使用 SDK 示例的 TUI 渲染（renderCall/renderResult）——
// 渲染层由 React 的 ToolCallCard / SubagentProgressCard 接管。
// ============================================================

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, formatAgentList } from "./agent-discovery.js";
import { runChainAgents, runParallelAgents, runSingleAgent } from "./agent-runner.js";
import {
	formatUsage,
	type SubagentDetails,
	type SubagentHost,
	type SubagentProgress,
	type SubagentResult,
} from "./types.js";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior step output" }),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both". Use "project" for project-local agents only.',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
});

/** 判断单个结果是否失败 */
function isFailedResult(result: SubagentResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

/** 生成 single 模式的可读摘要 */
function summarizeSingle(result: SubagentResult): string {
	const tag = isFailedResult(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
	const usage = formatUsage(result.usage, result.model);
	return `### [${result.agentName}] ${tag}${usage ? `\n${usage}` : ""}\n\n${result.finalOutput}`;
}

/**
 * 创建 SubAgent 扩展工厂。
 *
 * @param sessionId 父会话 pi session ID
 * @param host      SubagentHost（SessionRuntimeManager 实现）
 * @param cwd       父会话工作目录（用于发现项目级 Agent + 写入工具描述）
 */
export function createSubagentExtensionFactory(sessionId: string, host: SubagentHost, cwd: string): ExtensionFactory {
	// 在 bind 时发现一次 Agent，把列表写入工具描述，让 LLM 可见可用 Agent。
	// （Stage 3 的 Agent 编辑会触发 session reload → 重新 bind → 列表刷新。）
	const discovery = discoverAgents(cwd, "both");
	const agentListText = formatAgentList(discovery.agents);

	return (api) => {
		api.registerTool<typeof SubagentParams, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate tasks to specialized subagents with isolated context windows.",
				"Each subagent runs as a full Look session (visible nested under this session in the sidebar) and returns its final output.",
				"Modes: single ({agent, task}), parallel ({tasks:[{agent,task}]}), chain ({chain:[{agent,task}]} with {previous} placeholder).",
				'agentScope: "both" (default, user + project), "user" (~/.look/agents), or "project" (.pi/agents).',
				`Available agents: ${agentListText}.`,
				"Use this for complex, parallelizable, or specialized work that benefits from isolated context.",
			].join(" "),
			promptSnippet: "Delegate a task to a specialized subagent",
			parameters: SubagentParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, signal, onUpdate, _ctx) {
				// Stage 2: Agent 开关关闭时工具理论上已被移除（setActiveToolsByName），
				// 这里再做一次防御性检查。
				if (!host.isSubagentEnabled(sessionId)) {
					return {
						content: [{ type: "text", text: "SubAgent is disabled for this session." }],
						details: { mode: "single", agentScope: "both", results: [] },
					};
				}

				const agentScope = params.agentScope ?? "both";
				const runtimeDiscovery = discoverAgents(cwd, agentScope);
				const agents = runtimeDiscovery.agents;

				const hasChain = (params.chain?.length ?? 0) > 0;
				const hasTasks = (params.tasks?.length ?? 0) > 0;
				const hasSingle = Boolean(params.agent && params.task);
				const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

				const makeDetails =
					(mode: "single" | "parallel" | "chain") =>
					(results: SubagentResult[]): SubagentDetails => ({
						mode,
						agentScope,
						results,
					});

				const makeProgress =
					(parentSessionId: string): ((p: SubagentProgress) => void) =>
					(p) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `[${p.agentName}] ${p.status}${p.partialOutput ? `: ${p.partialOutput.slice(0, 200)}` : ""}`,
								},
							],
							details: makeDetails("parallel")([]),
						});
					};

				if (modeCount !== 1) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide exactly one mode (single / parallel / chain).\nAvailable agents: ${formatAgentList(agents)}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				// ── chain 模式 ──
				if (params.chain && params.chain.length > 0) {
					const { results, stoppedAtStep } = await runChainAgents(
						host,
						sessionId,
						agents,
						params.chain,
						signal,
						onUpdate ? makeProgress(sessionId) : undefined,
					);
					if (stoppedAtStep !== undefined) {
						const failed = results[results.length - 1];
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${stoppedAtStep} (${failed.agentName}): ${failed.finalOutput}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					const last = results[results.length - 1];
					return {
						content: [{ type: "text", text: last.finalOutput || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				}

				// ── parallel 模式 ──
				if (params.tasks && params.tasks.length > 0) {
					const results = await runParallelAgents(
						host,
						sessionId,
						agents,
						params.tasks,
						signal,
						onUpdate ? makeProgress(sessionId) : undefined,
					);
					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => summarizeSingle(r));
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				}

				// ── single 模式 ──
				if (params.agent && params.task) {
					const result = await runSingleAgent(
						host,
						sessionId,
						agents,
						params.agent,
						params.task,
						signal,
						onUpdate ? makeProgress(sessionId) : undefined,
					);
					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Agent ${result.status}: ${result.finalOutput}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: result.finalOutput || "(no output)" }],
						details: makeDetails("single")([result]),
					};
				}

				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${formatAgentList(agents)}` }],
					details: makeDetails("single")([]),
				};
			},
		});
	};
}
