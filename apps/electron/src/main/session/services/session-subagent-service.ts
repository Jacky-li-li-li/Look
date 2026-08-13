// ============================================================
// SessionSubagentService — sub-session creation and subagent toggles
//
// Owns runSubSession orchestration, per-session subagent enablement,
// global defaults, and agent-definition reload coordination.
// Depends on a narrow host port for runtime creation/events and on
// the permission/plan services for tool-state changes.
// ============================================================

import { randomUUID } from "node:crypto";
import type { AgentSession, ModelRegistry, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { AgentInfo, MainToRendererEvent } from "@look/shared/types";
import type { AgentDefinitionService } from "../../agents/definition-service.js";
import type { IPermissionService, IPlanService, ISessionScope } from "../../core/contracts.js";
import type { AgentConfig, SubagentProgress, SubagentResult } from "../../extensions/subagent/types.js";
import { SUBAGENT_TOOL_NAMES } from "../../extensions/subagent/types.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { UserSettingsStore } from "../../settings/store.js";
import { waitForPromptAccepted } from "../../utils/prompt-accepted.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";
import type { SubAgentRegistry } from "../subagent-registry.js";
import { DELEGATION_ENTRY_TYPE, SUBAGENT_PARENT_ENTRY_TYPE } from "./session-catalog.js";

export interface SessionSubagentHost {
	createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt: number,
		sessionStartEvent?: SessionStartEvent,
		options?: { appendSystemPrompt?: string[] },
	): Promise<ManagedRuntime>;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	getManagedRuntime(sessionId: string): ManagedRuntime | undefined;
	reloadSession(sessionId: string): Promise<void>;
	listRuntimeIds(): IterableIterator<string>;
	getProjectInfo(projectId: string): ReturnType<ProjectService["getProjectInfo"]>;
	emit(event: MainToRendererEvent): void;
	emitSessionUpdated(sessionId: string): void;
	getScope(sessionId: string): ISessionScope | undefined;
	acquireScope(sessionId: string, projectId: string): ISessionScope;
	runtimeInfo(sessionId: string): AgentInfo | undefined;
}

export interface SessionSubagentServiceDependencies {
	host: SessionSubagentHost;
	modelRegistry: Pick<ModelRegistry, "find">;
	subAgentRegistry: SubAgentRegistry;
	subAgentRuntimeService: SubAgentRuntimeService;
	permissionService: IPermissionService;
	planService: IPlanService;
	userSettings: UserSettingsStore;
	agentDefinitionService: AgentDefinitionService;
	maxSubagentDepth: number;
	maxNameLength: number;
}

export class SessionSubagentService {
	/** Per-session subagent override. */
	private readonly enabledBySession = new Map<string, boolean>();
	/** Default value inherited by newly bound sessions. */
	private defaultEnabled = true;

	constructor(private readonly deps: SessionSubagentServiceDependencies) {}

	// ── Default state ──

	getDefaultEnabled(): boolean {
		return this.defaultEnabled;
	}

	setDefaultEnabled(enabled: boolean): void {
		this.defaultEnabled = enabled;
	}

	loadDefaultFromSettings(): void {
		this.defaultEnabled = this.deps.userSettings.getAll().subagentEnabled;
	}

	// ── Per-session toggles ──

	isEnabled(sessionId: string): boolean {
		return this.enabledBySession.get(sessionId) ?? this.defaultEnabled;
	}

	async setEnabledForSession(sessionId: string, enabled: boolean): Promise<void> {
		await this.applyEnabled(sessionId, enabled);
	}

	async setEnabledGlobal(enabled: boolean): Promise<void> {
		this.defaultEnabled = enabled;
		await this.deps.userSettings.update({ subagentEnabled: enabled });
		await Promise.all(
			Array.from(this.deps.host.listRuntimeIds()).map((sessionId) => this.applyEnabled(sessionId, enabled)),
		);
	}

	/** Apply enabled state to a live session without touching persistence. */
	private async applyEnabled(sessionId: string, enabled: boolean): Promise<void> {
		this.enabledBySession.set(sessionId, enabled);
		const managed = this.deps.host.getManagedRuntime(sessionId);
		if (!managed) return;
		const session = managed.runtime.session;
		if (this.deps.permissionService.getMode(sessionId) === "plan") {
			this.deps.planService.syncToolState(sessionId);
			return;
		}
		if (enabled) {
			const configured = new Set(session.getAllTools().map((tool) => tool.name));
			const active = session.getActiveToolNames();
			const missing = SUBAGENT_TOOL_NAMES.filter((name) => configured.has(name) && !active.includes(name));
			if (missing.length > 0) session.setActiveToolsByName([...active, ...missing]);
		} else {
			session.setActiveToolsByName(
				session.getActiveToolNames().filter((name) => !(SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)),
			);
		}
	}

	/**
	 * Called once when a runtime is bound. Applies per-session override if one
	 * exists, otherwise falls back to the global default.
	 */
	applyDefaultOnBind(sessionId: string, session: AgentSession): void {
		const perSession = this.enabledBySession.get(sessionId);
		const enabled = perSession ?? this.defaultEnabled;
		if (!enabled) {
			session.setActiveToolsByName(
				session.getActiveToolNames().filter((name) => !(SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)),
			);
		}
		if (perSession === undefined && !this.defaultEnabled) {
			this.enabledBySession.set(sessionId, false);
		}
	}

	/** Clean up per-session override when a runtime is disposed. */
	clearSession(sessionId: string): void {
		this.enabledBySession.delete(sessionId);
	}

	// ── Agent definition coordination ──

	async setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<void> {
		const settings = this.deps.userSettings.getAll();
		let list = settings.enabledAgentDefinitions;
		if (list === null) {
			const all = (await this.deps.agentDefinitionService.listDefinitions()).map((a) => a.name);
			list = enabled ? all : all.filter((n) => n !== name);
		} else {
			list = enabled ? [...new Set([...list, name])] : list.filter((n) => n !== name);
		}
		await this.deps.userSettings.update({ enabledAgentDefinitions: list });
		await this.reloadAllSessionsForAgents();
	}

	async reloadAllSessionsForAgents(): Promise<void> {
		await Promise.all(
			Array.from(this.deps.host.listRuntimeIds()).map((sessionId) =>
				this.deps.host.reloadSession(sessionId).catch((error) => {
					console.warn("[Look][subagent] Failed to reload session after agent definition change:", error);
				}),
			),
		);
		this.deps.host.emit({ type: "subagent:definitions-updated" });
	}

	// ── Sub-session lifecycle ──

	async runSubSession(
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		signal: AbortSignal | undefined,
		title: string,
		toolCallId: string,
		taskTitle: string,
		onUpdate?: (progress: SubagentProgress) => void,
	): Promise<SubagentResult> {
		// Fail fast if the signal was already aborted before we start.
		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted"));
			throw reason;
		}

		// title 必填：子会话名固定为 Agent：<title>，不再自动拼接回退名
		const trimmedTitle = title.trim();
		if (!trimmedTitle) {
			throw new Error("Subagent title is required and must not be empty.");
		}

		const parentManaged = this.deps.host.getManagedRuntime(parentSessionId);
		if (!parentManaged) throw new Error(`Parent session ${parentSessionId} is not live`);

		let subDepth = 0;
		let ancestor = parentSessionId;
		while (true) {
			const parent = this.deps.subAgentRegistry.getParent(ancestor);
			if (!parent) break;
			subDepth++;
			ancestor = parent;
			if (subDepth >= this.deps.maxSubagentDepth) {
				throw new Error(
					`Subagent nesting limit of ${this.deps.maxSubagentDepth} exceeded. Cannot create nested sub-session under ${parentSessionId}.`,
				);
			}
		}

		const projectId = parentManaged.projectId;
		const project = this.deps.host.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project not found or invalid for subagent: ${projectId}`);
		const cwd = parentManaged.cwd;

		const subsessionDir = ensureWorkspaceSubsessionsDir(projectId);
		const sessionManager = SessionManager.create(cwd, subsessionDir);
		const managed = await this.deps.host.createManagedRuntime(
			cwd,
			sessionManager,
			projectId,
			Date.now(),
			undefined,
			agent.systemPrompt.trim() ? { appendSystemPrompt: [agent.systemPrompt] } : undefined,
		);
		const session = managed.runtime.session;
		const childSessionId = session.sessionId;

		// delegation entry 提升到 try 外：初始化中途抛错（如 runtimeInfo missing）时，
		// 外层 catch 需要追加 failed entry，否则侧栏子代理条目永久停留在 running。
		let delegation:
			| {
					delegationId: string;
					parentSessionId: string;
					childSessionId: string;
					agentName: string;
					status: "running";
					createdAt: string;
			  }
			| undefined;
		/** 运行中失败（resultPromise 错误分支）已写入 failed delegation 条目。
		 *  外层 catch 只负责初始化段失败——若已写入则不再补写，避免双条 failed。 */
		let delegationFailureWritten = false;

		try {
			const displayName = `Agent：${trimmedTitle}`.slice(0, this.deps.maxNameLength);
			session.setSessionName(displayName);

			// 继承父会话权限：定时任务等后台会话的父会话已设为 always，
			// 子会话需同步，否则会回退到默认的 ask 模式导致工具调用被阻塞
			const parentMode = this.deps.permissionService.getMode(parentSessionId);
			if (parentMode === "always") {
				this.deps.permissionService.setMode(childSessionId, "always");
			}

			if (agent.tools && agent.tools.length > 0) {
				const configured = new Set(session.getAllTools().map((tool) => tool.name));
				const allowlisted = agent.tools.filter((name: string) => configured.has(name));
				if (allowlisted.length === 0) {
					throw new Error(
						`Agent "${agent.name}" allowlist contains no valid tools. ` +
							`Configured tools: ${[...configured].join(", ") || "(none)"}`,
					);
				}
				session.setActiveToolsByName(allowlisted);
			}

			if (agent.model) {
				try {
					const slash = agent.model.indexOf("/");
					if (slash > 0) {
						const model = this.deps.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1));
						if (model) {
							await session.setModel(model);
							this.deps.host.emitSessionUpdated(childSessionId);
						}
					}
				} catch (error) {
					console.warn(`[Look][subagent] Failed to set model ${agent.model}:`, error);
				}
			} else {
				// 设计意图:子会话继承父会话当前模型(含用户中途切换)。
				// agent.model 未显式配置时,SDK 会按 settings 默认解析(不跟随父会话),
				// 这里显式继承;父会话也无模型则保持现状(bindRuntime 已有 ensureSessionModel 兜底)。
				const parentModel = parentManaged.runtime.session.model;
				if (parentModel) {
					try {
						await session.setModel(parentModel);
						this.deps.host.emitSessionUpdated(childSessionId);
					} catch (error) {
						console.warn(
							`[Look][subagent] Failed to inherit parent model ${parentModel.provider}/${parentModel.id}:`,
							error,
						);
					}
				}
			}

			session.sessionManager.appendCustomEntry(SUBAGENT_PARENT_ENTRY_TYPE, {
				parentSessionId,
				agentName: displayName,
			});
			delegation = {
				delegationId: randomUUID(),
				parentSessionId,
				childSessionId,
				agentName: displayName,
				status: "running" as const,
				createdAt: new Date().toISOString(),
			};
			session.sessionManager.appendCustomEntry(DELEGATION_ENTRY_TYPE, delegation);
			this.deps.subAgentRegistry.register(parentSessionId, childSessionId, displayName);

			const childInfo = this.deps.host.runtimeInfo(childSessionId);
			if (!childInfo) throw new Error(`Subagent runtime info missing for ${childSessionId}`);
			this.deps.host.emit({
				type: "agent:created",
				agentId: childSessionId,
				agent: childInfo,
			});

			// AbortSignal delegation: signal is passed to setupSubSessionTracking which
			// registers an abort listener that calls session.abort() on the child session.
			const resultPromise = this.deps.subAgentRuntimeService.setupSubSessionTracking(
				childSessionId,
				parentSessionId,
				agent,
				task,
				signal,
				onUpdate,
				displayName,
				toolCallId,
				taskTitle,
			);

			await waitForPromptAccepted(
				(onPreflight) =>
					session.prompt(task, {
						source: "rpc",
						streamingBehavior: session.isStreaming ? "followUp" : undefined,
						preflightResult: onPreflight,
					}),
				(error) => {
					this.deps.subAgentRuntimeService.finalizeSubSession(childSessionId, true);
					this.deps.host.emit({
						type: "error",
						agentId: childSessionId,
						message: error instanceof Error ? error.message : String(error),
					});
				},
			).catch((error) => {
				// Preflight / prompt rejection: finalize tracking and let the outer
				// catch write the delegation entry and clean up the runtime.
				// Do NOT write delegation here — the outer catch owns that to
				// prevent duplicate "failed" entries in the session JSONL.
				this.deps.subAgentRuntimeService.finalizeSubSession(childSessionId, true);
				throw error;
			});

			return resultPromise.then(
				(result) => {
					session.sessionManager.appendCustomEntry(DELEGATION_ENTRY_TYPE, {
						...delegation,
						status:
							result.status === "completed" ? "completed" : result.status === "aborted" ? "cancelled" : "failed",
						finishedAt: new Date().toISOString(),
					});
					return result;
				},
				(error) => {
					session.sessionManager.appendCustomEntry(DELEGATION_ENTRY_TYPE, {
						...delegation,
						status: signal?.aborted ? "cancelled" : "failed",
						finishedAt: new Date().toISOString(),
						error: error instanceof Error ? error.message : String(error),
					});
					// 标记已写：rethrow 后外层 catch 不得再补写第二条 failed 条目
					delegationFailureWritten = true;
					throw error;
				},
			);
		} catch (error) {
			// 初始化段（runtime 创建后、setupSubSessionTracking 之前）以及 prompt
			// preflight 失败重抛路径：子会话 runtime 已创建但无法/尚未建立跟踪时，
			// 必须清理 runtime，否则产生幽灵子会话常驻内存。
			// （allowlist 无有效工具、runtimeInfo missing、appendCustomEntry 失败、
			//   无 API key 等预检失败）
			console.error(`[Look][subagent] Failed to initialize subagent ${childSessionId}:`, error);
			if (delegation && !delegationFailureWritten) {
				// 仅初始化段失败（delegation entry 尚未由 resultPromise 错误分支写入）时
				// 补写 failed 状态，避免侧栏子代理条目永久停留在 running；运行中失败
				// 已由错误分支写过，此处跳过防止双条 failed 条目。
				try {
					session.sessionManager.appendCustomEntry(DELEGATION_ENTRY_TYPE, {
						...delegation,
						status: "failed",
						finishedAt: new Date().toISOString(),
						error: error instanceof Error ? error.message : String(error),
					});
				} catch (entryError) {
					console.warn("[Look][subagent] failed to write delegation failed entry:", entryError);
				}
			}
			this.deps.subAgentRegistry.unregister(childSessionId);
			await this.deps.host
				.disposeRuntime(childSessionId, true)
				.catch((err: unknown) => console.warn("[Look][subagent] cleanup after init failure failed:", err));
			throw error;
		}
	}
}
