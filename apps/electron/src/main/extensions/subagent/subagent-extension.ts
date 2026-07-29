// ============================================================
// SubAgent Extension — 扩展入口（ExtensionFactory）
//
// 注册三个工具到 pi SDK（每种执行模式一个）：
//   - subagent:          single  单个子会话 {agent, task, title}
//   - subagent_parallel: 并发多个子会话 {tasks: [{agent, task, title}]}
//   - subagent_chain:    顺序子会话链 {chain: [{agent, task, title}]}，
//                        task 可含 {previous} 占位符
//
// 为什么不合并为一个 union schema 工具：主流 provider（DeepSeek/
// OpenAI 兼容、Anthropic）要求工具参数顶层必须是 type: "object"，
// 顶层 anyOf（union）会被直接 400 拒绝。拆成三个独立 object schema
// 后，每个模式的 title 都能做到 schema 级必填。
//
// title 为必填：子会话名固定为 Agent：<title>（见 SessionSubagentService）。
//
// 注入点：SessionRuntimeManager.buildExtensionFactories()，与
// permission / plan 扩展同等的 ExtensionFactory 机制。
//
// Look 不使用 SDK 示例的 TUI 渲染（renderCall/renderResult）——
// 渲染层接管。
// ============================================================

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, formatAgentList } from "./agent-discovery.js";
import { runChainAgents, runParallelAgents, runSingleAgent } from "./agent-runner.js";
import {
	type AgentScope,
	formatUsage,
	type SubagentDetails,
	type SubagentHost,
	type SubagentProgress,
	type SubagentResult,
} from "./types.js";

const TITLE_DESCRIPTION =
	"Short display title for this sub-session (a few words naming the task); becomes the session name (Agent：<title>) in the sidebar";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	title: Type.String({ description: TITLE_DESCRIPTION }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior step output" }),
	title: Type.String({ description: TITLE_DESCRIPTION }),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both". Use "project" for project-local agents only.',
	default: "both",
});

const AGENT_SCOPE_DESCRIPTION =
	'agentScope: "both" (default, user + project), "user" (~/.look/agents), or "project" (~/.look/projects/<id>/agents).';

const SingleParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	title: Type.String({ description: TITLE_DESCRIPTION }),
	agentScope: Type.Optional(AgentScopeSchema),
});

const ParallelParams = Type.Object({
	tasks: Type.Array(TaskItem, { description: "Array of {agent, task, title} to execute in parallel" }),
	agentScope: Type.Optional(AgentScopeSchema),
});

const ChainParams = Type.Object({
	chain: Type.Array(ChainItem, { description: "Array of {agent, task, title} to execute sequentially" }),
	agentScope: Type.Optional(AgentScopeSchema),
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

/** 工具 onUpdate 回调的结构化类型（与 SDK 的 AgentToolResult 结构兼容） */
type ToolUpdateFn =
	| ((update: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void)
	| undefined;

/**
 * 创建 SubAgent 扩展工厂。
 *
 * @param sessionId 父会话 pi session ID
 * @param host      SubagentHost（SessionRuntimeManager 实现）
 * @param projectId 项目 ID（用于发现项目级 Agent + 写入工具描述）
 */
export async function createSubagentExtensionFactory(
	sessionId: string,
	host: SubagentHost,
	projectId: string,
): Promise<ExtensionFactory> {
	// 在 bind 时发现一次 Agent，把列表写入工具描述，让 LLM 可见可用 Agent。
	// （Stage 3 的 Agent 编辑会触发 session reload → 重新 bind → 列表刷新。）
	const discovery = await discoverAgents(projectId, "both");
	const agentListText = formatAgentList(discovery.agents);

	return (api) => {
		/** 子会话进度 → 父会话工具流式更新 */
		const forwardProgress =
			(onUpdate: ToolUpdateFn) =>
			(p: SubagentProgress): void => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `[${p.agentName}] ${p.status}${p.partialOutput ? `: ${p.partialOutput.slice(0, 200)}` : ""}`,
						},
					],
					details: { mode: "parallel", agentScope: "both", results: [] },
				});
			};

		const disabledResult = (mode: SubagentDetails["mode"]) => ({
			content: [{ type: "text" as const, text: "SubAgent is disabled for this session." }],
			details: { mode, agentScope: "both" as AgentScope, results: [] },
		});

		const makeDetails =
			(mode: SubagentDetails["mode"], agentScope: AgentScope) =>
			(results: SubagentResult[]): SubagentDetails => ({
				mode,
				agentScope,
				results,
			});

		// ── single：单个子会话 ──
		api.registerTool<typeof SingleParams, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate a single task to a specialized subagent with an isolated context window.",
				"The subagent runs as a full Look session (visible nested under this session in the sidebar) and returns its final output.",
				'"title" is required: a few words naming the task; it becomes the session name (Agent：<title>) in the sidebar.',
				AGENT_SCOPE_DESCRIPTION,
				`Available agents: ${agentListText}.`,
				"For multiple independent tasks use subagent_parallel; for sequential steps use subagent_chain.",
			].join(" "),
			promptSnippet: "Delegate a task to a specialized subagent",
			parameters: SingleParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, signal, onUpdate, _ctx) {
				if (!host.isSubagentEnabled(sessionId)) return disabledResult("single");

				const agentScope = params.agentScope ?? "both";
				const { agents } = await discoverAgents(projectId, agentScope);

				const result = await runSingleAgent(
					host,
					sessionId,
					agents,
					params.agent,
					params.task,
					signal,
					params.title,
					_toolCallId,
					forwardProgress(onUpdate),
				);
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.status}: ${result.finalOutput}` }],
						details: makeDetails("single", agentScope)([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: result.finalOutput || "(no output)" }],
					details: makeDetails("single", agentScope)([result]),
				};
			},
		});

		// ── parallel：并发多个子会话 ──
		api.registerTool<typeof ParallelParams, SubagentDetails>({
			name: "subagent_parallel",
			label: "Subagent Parallel",
			description: [
				"Run multiple subagent tasks in parallel, each with an isolated context window.",
				"Each subagent runs as a full Look session (visible nested under this session in the sidebar) and returns its final output.",
				'Each item\'s "title" is required: a few words naming the task; it becomes the session name (Agent：<title>) in the sidebar.',
				AGENT_SCOPE_DESCRIPTION,
				`Available agents: ${agentListText}.`,
				"Use this for complex, parallelizable work; for a single task use subagent; for sequential steps use subagent_chain.",
			].join(" "),
			promptSnippet: "Run multiple subagent tasks in parallel",
			parameters: ParallelParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, signal, onUpdate, _ctx) {
				if (!host.isSubagentEnabled(sessionId)) return disabledResult("parallel");

				const agentScope = params.agentScope ?? "both";
				const { agents } = await discoverAgents(projectId, agentScope);

				if (params.tasks.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide at least one task.\nAvailable agents: ${formatAgentList(agents)}`,
							},
						],
						details: makeDetails("parallel", agentScope)([]),
						isError: true,
					};
				}
				const results = await runParallelAgents(
					host,
					sessionId,
					agents,
					params.tasks,
					signal,
					_toolCallId,
					forwardProgress(onUpdate),
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
					details: makeDetails("parallel", agentScope)(results),
				};
			},
		});

		// ── chain：顺序子会话链（{previous} 占位符） ──
		api.registerTool<typeof ChainParams, SubagentDetails>({
			name: "subagent_chain",
			label: "Subagent Chain",
			description: [
				"Run subagent steps sequentially; each step's task may contain a {previous} placeholder that is replaced with the prior step's output.",
				"Each subagent runs as a full Look session (visible nested under this session in the sidebar) and returns its final output.",
				'Each item\'s "title" is required: a few words naming the task; it becomes the session name (Agent：<title>) in the sidebar.',
				AGENT_SCOPE_DESCRIPTION,
				`Available agents: ${agentListText}.`,
				"The chain stops at the first failed step. For independent parallel work use subagent_parallel; for a single task use subagent.",
			].join(" "),
			promptSnippet: "Run subagent steps sequentially with {previous} chaining",
			parameters: ChainParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, signal, onUpdate, _ctx) {
				if (!host.isSubagentEnabled(sessionId)) return disabledResult("chain");

				const agentScope = params.agentScope ?? "both";
				const { agents } = await discoverAgents(projectId, agentScope);

				if (params.chain.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide at least one chain step.\nAvailable agents: ${formatAgentList(agents)}`,
							},
						],
						details: makeDetails("chain", agentScope)([]),
						isError: true,
					};
				}
				const { results, stoppedAtStep } = await runChainAgents(
					host,
					sessionId,
					agents,
					params.chain,
					signal,
					_toolCallId,
					forwardProgress(onUpdate),
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
						details: makeDetails("chain", agentScope)(results),
						isError: true,
					};
				}
				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: last.finalOutput || "(no output)" }],
					details: makeDetails("chain", agentScope)(results),
				};
			},
		});
	};
}
