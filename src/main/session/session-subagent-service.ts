// ============================================================
// SessionSubagentService — sub-session creation and subagent toggles
//
// Owns runSubSession orchestration, per-session subagent enablement,
// global defaults, and agent-definition reload coordination.
// Depends on a narrow host port for runtime creation/events and on
// the permission/plan services for tool-state changes.
// ============================================================

import type { AgentSession, ModelRegistry, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { AgentInfo, MainToRendererEvent } from "@look/shared/types";
import type { AgentDefinitionService } from "../agents/definition-service.js";
import type { IPermissionService, IPlanService, ISessionScope } from "../core/contracts.js";
import type { AgentConfig, SubagentProgress, SubagentResult } from "../extensions/subagent/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SubAgentRuntimeService } from "../services/subagent-runtime.js";
import type { UserSettingsStore } from "../settings/store.js";
import type { ManagedRuntime } from "./runtime-registry.js";
import { SUBAGENT_PARENT_ENTRY_TYPE } from "./session-catalog.js";
import type { SubAgentRegistry } from "./subagent-registry.js";

export interface SessionSubagentHost {
	createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt: number,
		sessionStartEvent?: SessionStartEvent,
		options?: { appendSystemPrompt?: string[] },
	): Promise<ManagedRuntime>;
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
			if (!configured.has("subagent")) return;
			const active = session.getActiveToolNames();
			if (!active.includes("subagent")) session.setActiveToolsByName([...active, "subagent"]);
		} else {
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
		}
	}

	/** Called once when a runtime is bound. Only mutates tools when default is off. */
	applyDefaultOnBind(sessionId: string, session: AgentSession): void {
		if (this.defaultEnabled) return;
		this.enabledBySession.set(sessionId, false);
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
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
		onUpdate?: (progress: SubagentProgress) => void,
		title?: string,
	): Promise<SubagentResult> {
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
		const cwd = parentManaged.runtime.cwd;

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

		const rawName = title?.trim()
			? title.trim()
			: `${agent.title || agent.name} · ${task.replace(/\s+/g, " ").trim().slice(0, 48)}`;
		const displayName = `Agent：${rawName}`.slice(0, this.deps.maxNameLength);
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
		}

		session.sessionManager.appendCustomEntry(SUBAGENT_PARENT_ENTRY_TYPE, {
			parentSessionId,
			agentName: displayName,
		});
		this.deps.subAgentRegistry.register(parentSessionId, childSessionId, displayName);

		const childInfo = this.deps.host.runtimeInfo(childSessionId);
		if (!childInfo) throw new Error(`Subagent runtime info missing for ${childSessionId}`);
		this.deps.host.emit({
			type: "agent:created",
			agentId: childSessionId,
			agent: childInfo,
		});

		const resultPromise = this.deps.subAgentRuntimeService.setupSubSessionTracking(
			childSessionId,
			parentSessionId,
			agent,
			task,
			signal,
			onUpdate,
			displayName,
		);

		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void session
				.prompt(task, {
					source: "rpc",
					streamingBehavior: session.isStreaming ? "followUp" : undefined,
					preflightResult: (success) => {
						if (!success || accepted) return;
						accepted = true;
						resolve();
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
					else {
						this.deps.host.emit({
							type: "error",
							agentId: childSessionId,
							message: error instanceof Error ? error.message : String(error),
						});
					}
				});
		}).catch((error) => {
			this.deps.subAgentRuntimeService.finalizeSubSession(childSessionId, true);
			throw error;
		});

		return resultPromise;
	}
}
