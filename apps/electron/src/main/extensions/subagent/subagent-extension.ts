// ============================================================
// SubAgent Extension — 扩展入口（ExtensionFactory）
//
// 注册五个工具到 pi SDK：
//   - subagent:          single  单个子会话 {agent, task, title}
//   - subagent_parallel: 并发多个子会话 {tasks, runId?, maxWaitMs?}
//                        runId 用于续等同一批任务（总指挥模式：到点返回
//                        部分结果+运行中清单，不判死）
//   - subagent_chain:    顺序子会话链 {chain: [{agent, task, title}]}，
//                        task 可含 {previous} 占位符
//   - subagent_status:   查询并行 run 的实时状态（总指挥可随时查看）
//   - subagent_cancel:   取消并行 run 的单个任务或整批
//
// 为什么不合并为一个 union schema 工具：主流 provider（DeepSeek/
// OpenAI 兼容、Anthropic）要求工具参数顶层必须是 type: "object"，
// 顶层 anyOf（union）会被直接 400 拒绝。拆成独立 object schema
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
import { parallelRunStore } from "./parallel-run-store.js";
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
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Array of {agent, task, title} to execute in parallel. Required for a new run; ignored (may be omitted or empty) when runId is provided.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	runId: Type.Optional(
		Type.String({
			description:
				'Resume an existing parallel run: pass the runId returned by a previous subagent_parallel call to keep waiting for its remaining tasks. When provided, "tasks" is ignored (may be omitted or empty). If the runId is unknown, a new run is started.',
		}),
	),
	maxWaitMs: Type.Optional(
		Type.Number({
			description:
				"Max milliseconds to wait in this call before returning partial results (completed results + still-running task list). This is a progress report point, NOT a failure: pass the same runId again to keep waiting. Default 300000 (5 min); env LOOK_SUBAGENT_MAX_WAIT_MS overrides.",
			minimum: 1_000,
		}),
	),
});

const StatusParams = Type.Object({
	runId: Type.Optional(
		Type.String({
			description:
				"Run ID from a subagent_parallel call. Omit to query the most recent parallel run of this session.",
		}),
	),
});

const CancelParams = Type.Object({
	runId: Type.String({ description: "Run ID from a subagent_parallel call." }),
	taskIndex: Type.Optional(
		Type.Number({
			description:
				"Cancel only the task at this 0-based index (from the original tasks array). Omit to cancel all remaining tasks of the run.",
			minimum: 0,
		}),
	),
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
		/** 子会话进度 → 父会话工具流式更新（mode/scope 由调用方传入，避免误标 parallel） */
		const forwardProgress =
			(onUpdate: ToolUpdateFn, mode: SubagentDetails["mode"], agentScope: AgentScope) =>
			(p: SubagentProgress): void => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `[${p.agentName}] ${p.status}${p.partialOutput ? `: ${p.partialOutput.slice(0, 200)}` : ""}`,
						},
					],
					details: { mode, agentScope, results: [] },
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
					forwardProgress(onUpdate, "single", agentScope),
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

				// 续等模式：只带 runId 时不要求 tasks
				const tasks = params.tasks ?? [];
				if (!params.runId && tasks.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide at least one task, or pass runId to resume an existing run.\nAvailable agents: ${formatAgentList(agents)}`,
							},
						],
						details: makeDetails("parallel", agentScope)([]),
						isError: true,
					};
				}
				const snapshot = await runParallelAgents(
					host,
					sessionId,
					agents,
					tasks,
					signal,
					_toolCallId,
					forwardProgress(onUpdate, "parallel", agentScope),
					{ runId: params.runId, maxWaitMs: params.maxWaitMs },
				);
				const { results, pending, runId, total, settled } = snapshot;
				const successCount = results.filter((r) => !isFailedResult(r)).length;

				// 尚未全部结算：返回中间状态（汇报点，不是失败）。父会话可携 runId 续等。
				if (!settled) {
					// 已完成任务只给一行摘要（避免多轮续等重复携带全量报告，节省 token）
					const doneSummaries = results
						.map((r) => {
							const tag = isFailedResult(r) ? "failed" : "completed";
							const usage = formatUsage(r.usage, r.model);
							return `- ${r.agentName}: ${tag}${usage ? ` — ${usage}` : ""}`;
						})
						.join("\n");
					// pending 编号用原始 taskIndex，与 subagent_status / subagent_cancel 对齐
					const pendingList = pending
						.map(({ task, index }) => `- [${index + 1}/${total}] ${task.title} (agent: ${task.agent})`)
						.join("\n");
					return {
						content: [
							{
								type: "text",
								text: `Parallel run ${runId}: ${results.length}/${total} settled, ${pending.length} still running after waiting (not a failure).\n\n已完成：\n${doneSummaries || "(none yet)"}\n\n仍在运行：\n${pendingList}\n\n继续等待：调用 subagent_parallel 并传 runId="${runId}"（可带 maxWaitMs，缺省 5 分钟）；查询状态用 subagent_status；取消用 subagent_cancel。`,
							},
						],
						details: makeDetails("parallel", agentScope)(results),
					};
				}

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
					forwardProgress(onUpdate, "chain", agentScope),
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

		// ── status：查询并行 run 状态（总指挥模式：父会话可随时查） ──
		api.registerTool<typeof StatusParams, SubagentDetails>({
			name: "subagent_status",
			label: "Subagent Status",
			description: [
				"Query the live status of a subagent_parallel run: which tasks are done, still running, or were cancelled.",
				"Pass runId from a subagent_parallel call; omit runId to query the most recent parallel run of this session.",
				"Use this when a parallel run returned partial results and you need to decide whether to keep waiting (subagent_parallel with runId), cancel a stuck task (subagent_cancel), or proceed with what is done.",
			].join(" "),
			promptSnippet: "Query subagent parallel run status",
			parameters: StatusParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!host.isSubagentEnabled(sessionId)) return disabledResult("parallel");

				const run = params.runId
					? parallelRunStore.get(params.runId)
					: parallelRunStore.getLatestForParent(sessionId);
				if (!run) {
					return {
						content: [
							{
								type: "text",
								text: params.runId
									? `No parallel run found for runId "${params.runId}". It may have been cleaned up (runs are kept ~30 minutes after settling). Start a new run with subagent_parallel.`
									: "No parallel run found for this session. Start one with subagent_parallel.",
							},
						],
						details: makeDetails("parallel", "both")([]),
						isError: true,
					};
				}

				const lines: string[] = [
					`Parallel run ${run.runId}: ${run.tasks.filter((t) => t.result).length}/${run.tasks.length} settled${run.settled ? " (all done)" : " (still running)"}`,
				];
				run.tasks.forEach((task, i) => {
					const def = task.task;
					const progress = task.lastProgress;
					const result = task.result;
					if (result) {
						const tag = isFailedResult(result)
							? `failed${result.stopReason ? ` (${result.stopReason})` : ""}`
							: "completed";
						const usage = formatUsage(result.usage, result.model);
						lines.push(
							`- [${i + 1}/${run.tasks.length}] ${def.title} (${def.agent}): ${tag}${usage ? ` — ${usage}` : ""}`,
						);
						if (result.finalOutput) lines.push(`  output: ${result.finalOutput.slice(0, 300)}`);
					} else if (progress) {
						const usage = formatUsage(progress.usage, progress.model);
						lines.push(
							`- [${i + 1}/${run.tasks.length}] ${def.title} (${def.agent}): running${usage ? ` — ${usage}` : ""}`,
						);
						if (progress.partialOutput) lines.push(`  partial: ${progress.partialOutput.slice(0, 300)}`);
					} else {
						lines.push(`- [${i + 1}/${run.tasks.length}] ${def.title} (${def.agent}): queued`);
					}
				});
				lines.push(
					`To keep waiting, call subagent_parallel with runId="${run.runId}"; to cancel a task, call subagent_cancel with the same runId (optionally taskIndex).`,
				);

				const results = run.tasks.filter((t) => t.result).map((t) => t.result!);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("parallel", "both")(results),
				};
			},
		});

		// ── cancel：取消并行 run 的单个任务或整批（总指挥模式） ──
		api.registerTool<typeof CancelParams, SubagentDetails>({
			name: "subagent_cancel",
			label: "Subagent Cancel",
			description: [
				"Cancel a parallel subagent run or one of its tasks.",
				"Pass runId from a subagent_parallel call. Omit taskIndex to cancel all remaining tasks of the run; pass taskIndex (0-based) to cancel just that task.",
				"Cancelled tasks are settled as aborted; completed tasks are unaffected. After cancelling, use subagent_status to confirm.",
			].join(" "),
			promptSnippet: "Cancel subagent parallel run or task",
			parameters: CancelParams,
			executionMode: "parallel",

			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!host.isSubagentEnabled(sessionId)) return disabledResult("parallel");

				const run = parallelRunStore.get(params.runId);
				if (!run) {
					return {
						content: [
							{
								type: "text",
								text: `No parallel run found for runId "${params.runId}". It may have been cleaned up or already settled.`,
							},
						],
						details: makeDetails("parallel", "both")([]),
						isError: true,
					};
				}

				const cancelled: string[] = [];
				if (params.taskIndex !== undefined) {
					const task = run.tasks[params.taskIndex];
					if (!task || task.result) {
						return {
							content: [
								{
									type: "text",
									text: `Task index ${params.taskIndex} is out of range or already settled. Use subagent_status to see the current state.`,
								},
							],
							details: makeDetails("parallel", "both")([]),
							isError: true,
						};
					}
					const ok = parallelRunStore.cancelTask(run.runId, params.taskIndex);
					if (ok) cancelled.push(`[${params.taskIndex + 1}/${run.tasks.length}] ${task.task.title}`);
				} else {
					const count = parallelRunStore.cancelAll(run.runId);
					if (count > 0) cancelled.push(`${count} task(s)`);
				}

				return {
					content: [
						{
							type: "text",
							text:
								cancelled.length > 0
									? `Cancelled: ${cancelled.join(", ")}. Use subagent_status to confirm; completed tasks are unaffected.`
									: "Nothing to cancel (tasks already settled).",
						},
					],
					details: makeDetails("parallel", "both")([]),
				};
			},
		});
	};
}
