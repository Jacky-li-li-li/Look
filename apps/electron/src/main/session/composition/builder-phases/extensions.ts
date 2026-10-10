// CompositionBuilder phase
import path from "node:path";
import { getLookDir, getProjectSharedDir } from "@look/shared/look-storage";
import { createBrowserExtensionFactory } from "../../../extensions/browser-extension.js";
import { createComputerUseExtensionFactory } from "../../../extensions/computer-use-extension.js";
import { createMcpExtensionFactory } from "../../../extensions/mcp-extension.js";
import { createModelListExtensionFactory } from "../../../extensions/model-extension.js";
import { createPermissionExtensionFactory } from "../../../extensions/permission-extension.js";
import { createPlanExtensionFactory } from "../../../extensions/plan-extension.js";
import { createSkillInjectExtensionFactory } from "../../../extensions/skill-inject-extension.js";
import { discoverAgents } from "../../../extensions/subagent/agent-discovery.js";
import { createSubagentExtensionFactory } from "../../../extensions/subagent/subagent-extension.js";
import type { AgentConfig, SubagentProgress } from "../../../extensions/subagent/types.js";
import { createTranscribeExtensionFactory } from "../../../extensions/transcribe-extension.js";
import { getAvailableModels } from "../../../models/model-queries.js";
import { SessionRuntimeFactory } from "../../runtime/runtime-factory.js";
import type { CompositionBuilder } from "../builder-context.js";

export function buildExtensionsPhase(b: CompositionBuilder): void {
	const modelRuntime = b.req(b.modelRuntime, "modelRuntime");

	b.runtimeFactory = new SessionRuntimeFactory({
		agentDir: getLookDir(),
		modelRuntime,
		findProjectIdByCwd: (cwd) => b.findProjectIdByCwd(cwd),
		resolveProjectTrust: (cwd) => b.req(b.projectService, "projectService").resolveProjectTrust(cwd),
		buildExtensionFactories: async (cwd, sessionId, projectId) => {
			const resolvedProjectId = projectId ?? b.runtimeRegistry.get(sessionId)?.projectId ?? "";
			const permissionHandler = b.req(b.permissionService, "permissionService").createToolCallHandler(cwd);
			return [
				createPermissionExtensionFactory(permissionHandler),
				createPlanExtensionFactory(sessionId, {
					getMode: (id) => b.req(b.permissionService, "permissionService").getMode(id),
					askQuestions: (id, questions, signal) =>
						b.req(b.planService, "planService").requestQuestions(id, questions, signal),
					submitPlan: (id, plan, signal) => b.req(b.planService, "planService").requestApproval(id, plan, signal),
				}),
				createModelListExtensionFactory(async () => getAvailableModels(b.req(b.modelRegistry, "modelRegistry"))),
				await createSubagentExtensionFactory(
					sessionId,
					{
						discoverAgents: async (_projectId, scope) => {
							const result = await discoverAgents(resolvedProjectId, scope);
							const enabled = b.req(b.userSettings, "userSettings").getAll().enabledAgentDefinitions;
							if (enabled === null) return result;
							// discoverAgents 有短 TTL 缓存且按引用返回：不能原地改写
							// result.agents（会毒化缓存，其他调用方 5s 内看到过滤后的
							// 列表），必须克隆一份再过滤。
							return {
								...result,
								agents: result.agents.filter((agent) => enabled.includes(agent.name)),
							};
						},
						runSubSession: (
							parentId: string,
							agent: AgentConfig,
							task: string,
							signal: AbortSignal | undefined,
							title: string,
							toolCallId: string,
							taskTitle: string,
							onUpdate?: (progress: SubagentProgress) => void,
						) =>
							b
								.req(b.sessionSubagentService, "sessionSubagentService")
								.runSubSession(parentId, agent, task, signal, title, toolCallId, taskTitle, onUpdate),
						isSubagentEnabled: (id) => b.req(b.sessionSubagentService, "sessionSubagentService").isEnabled(id),
					},
					resolvedProjectId,
				),
				createMcpExtensionFactory(sessionId, b.req(b.mcpManager, "mcpManager"), cwd, resolvedProjectId, (cwd) =>
					b.req(b.projectService, "projectService").resolveProjectTrust(cwd),
				),
				createSkillInjectExtensionFactory(),
				// 截图落盘到项目共享区（守卫白名单内，共享面板可见，
				// 路径芯片点击可预览）；无项目时不落盘，仅内联返回。
				// 非 macOS 不注册：computer-use 服务依赖 macOS 专属 TCC API，
				// 见构造处注释（computerUseService 为 null 时跳过）。
				...(b.computerUseService
					? [
							createComputerUseExtensionFactory(
								b.computerUseService,
								resolvedProjectId ? path.join(getProjectSharedDir(resolvedProjectId), "screenshots") : null,
							),
						]
					: []),
				createBrowserExtensionFactory(
					b.req(b.browserService, "browserService"),
					(cwd) => b.req(b.projectService, "projectService").resolveProjectTrust(cwd),
					cwd,
				),
				// 转录稿落盘到项目共享区 transcripts 目录（共享面板可见、
				// 路径稳定可点）；无项目时不落盘到共享区，回退系统临时目录。
				createTranscribeExtensionFactory({
					service: b.req(b.transcribeService, "transcribeService"),
					sharedDir: resolvedProjectId ? path.join(getProjectSharedDir(resolvedProjectId), "transcripts") : null,
				}),
			];
		},
	});
}
