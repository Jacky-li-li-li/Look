// ============================================================
// SessionLifecycleService — create / destroy / abort sessions
//
// Owns high-level session lifecycle orchestration so that the runtime
// façade only wires dependencies and delegates.
// ============================================================

import fs from "node:fs";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDir } from "@look/shared/look-storage";
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type { ImSessionProvider, MainToRendererEvent, SessionSnapshotEnvelope } from "@look/shared/types";
import type { IPermissionService, IPlanService } from "../../core/contracts.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { UserSettingsStore } from "../../settings/store.js";
import { MAX_NAME_LENGTH } from "../constants.js";
import type { ManagedRuntime, RuntimeRegistry } from "../runtime/runtime-registry.js";
import type { SessionScopeRegistry } from "../scope/scope-registry.js";
import type { StoredSession } from "./session-catalog.js";
import type { SessionInfoService } from "./session-info-service.js";

type AvailableModel = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
};

export interface SessionLifecycleHost {
	createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt: number,
		sessionStartEvent?: import("@earendil-works/pi-coding-agent").SessionStartEvent,
		options?: { appendSystemPrompt?: string[] },
	): Promise<ManagedRuntime>;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	refreshProjectSessions(projectId: string): Promise<StoredSession[]>;
	getStoredSession(sessionId: string): StoredSession | undefined;
	/** Remove a session from the catalog index (before disposing its runtime). */
	removeStoredSession(sessionId: string): void;
	emit(event: MainToRendererEvent): void;
	emitSessionState(sessionId: string, reason?: SessionSnapshotEnvelope["reason"]): void;
	emitSessionList(projectId: string): void;
	setActiveProjectId(projectId: string): void;
	setActiveSessionId(sessionId: string | null): void;
	getActiveSessionId(): string | null;
}

export interface SessionLifecycleServiceDependencies {
	host: SessionLifecycleHost;
	projectService: ProjectService;
	runtimeRegistry: Pick<RuntimeRegistry, "get">;
	scopeRegistry: Pick<SessionScopeRegistry, "get">;
	subAgentRuntimeService: SubAgentRuntimeService;
	sessionInfoService: SessionInfoService;
	permissionService: IPermissionService;
	planService: IPlanService;
	userSettings: UserSettingsStore;
	modelRegistry: Pick<ModelRegistry, "find">;
	getAvailableModelsSync(): AvailableModel[];
}

export interface EnsureSessionModelDeps {
	getAvailableModelsSync(): AvailableModel[];
	modelRegistry: Pick<ModelRegistry, "find">;
	userSettings: Pick<UserSettingsStore, "getAll" | "update">;
}

/**
 * 确保会话有模型 —— 新建/历史恢复/子会话统一入口(由 runtime-lifecycle-coordinator
 * 的 bindRuntime 调用)。
 *
 * - 已解析出模型 → 跳过
 * - 未解析(SDK findInitialModel 在快照失真/无可用时静默返回 undefined) →
 *   取首个可用模型 setModel;setModel 内部用实时 checkAuth 校验凭据
 *   (agent-session.js),失败 throw → 忽略,保持现状(发送时会报明确错误)
 * - setModel 副作用:持久化 defaultProvider/defaultModel 到 settings.json
 *   (agent-session.js setDefaultModelAndProvider)。若用户已设置全局默认模型
 *   且与兜底模型不同,恢复原默认 —— 与 plan 模式切换的防污染机制一致。
 */
export async function ensureSessionModel(
	session: { model: unknown; setModel(model: unknown): Promise<unknown> },
	deps: EnsureSessionModelDeps,
): Promise<void> {
	if (session.model) return;
	const savedPreferred = deps.userSettings.getAll().preferredModel;
	try {
		const available = deps.getAvailableModelsSync();
		if (available.length === 0) return;
		const first = available[0];
		const model = deps.modelRegistry.find(first.provider, first.id);
		if (!model) return;
		await session.setModel(model);
		// 防污染:兜底模型与用户全局默认不同时恢复原默认
		if (savedPreferred && savedPreferred !== `${model.provider}/${model.id}`) {
			await deps.userSettings.update({ preferredModel: savedPreferred });
		}
	} catch {
		// 兜底失败保持现状,不阻断
	}
}

export class SessionLifecycleService {
	constructor(private readonly deps: SessionLifecycleServiceDependencies) {}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider; background?: boolean } | string,
	): Promise<string> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.deps.projectService.activeId;
		if (!projectId) throw new Error("No active project");
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		const managed = await this.deps.host.createManagedRuntime(
			project.cwd,
			SessionManager.create(project.cwd, ensureWorkspaceDir(projectId)),
			projectId,
			Date.now(),
		);
		const session = managed.runtime.session;
		session.setSessionName((input.name?.trim() || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH));

		const scope = this.deps.scopeRegistry.get(session.sessionId);
		if (scope) scope.isDefaultName = true;
		if (input.imProvider) {
			const scope = this.deps.scopeRegistry.get(session.sessionId);
			if (scope) scope.imProvider = input.imProvider;
		}

		if (!input.background) {
			this.deps.host.setActiveProjectId(projectId);
			this.deps.host.setActiveSessionId(session.sessionId);
		}
		await this.deps.host.refreshProjectSessions(projectId);
		const agent = this.deps.sessionInfoService.getAgentInfo(session.sessionId);
		if (agent) {
			this.deps.host.emit({ type: "agent:created", agentId: session.sessionId, agent });
		}
		this.deps.host.emitSessionState(session.sessionId, "initial");
		return session.sessionId;
	}

	async destroyAgent(sessionId: string): Promise<void> {
		await this.deps.subAgentRuntimeService.destroySubSessions(sessionId);
		const stored = this.deps.host.getStoredSession(sessionId);
		const managed = this.deps.runtimeRegistry.get(sessionId);
		const projectId = stored?.projectId ?? managed?.projectId;
		if (!projectId) return;
		// 先从目录索引移除 stored：disposeRuntime 进行中/完成后，任何并发
		// ensureRuntime（如排队中的 applyMode 权限切换）都会因 getStoredSession
		// 为空而失败，不会为"正在删除"的会话重建幽灵 runtime。随后的
		// refreshProjectSessions 基于磁盘（文件已删）重建索引，结果一致。
		if (stored) this.deps.host.removeStoredSession(sessionId);
		await this.deps.host.disposeRuntime(sessionId, true);
		if (stored) {
			try {
				fs.unlinkSync(stored.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
		}
		if (this.deps.host.getActiveSessionId() === sessionId) {
			this.deps.host.setActiveSessionId(null);
		}
		await this.deps.host.refreshProjectSessions(projectId);
		this.deps.host.emit({ type: "agent:destroyed", agentId: sessionId });
		this.deps.host.emitSessionList(projectId);
	}

	async abortAgent(sessionId: string): Promise<void> {
		const managed = this.deps.runtimeRegistry.get(sessionId);
		if (!managed) return;
		await this.deps.subAgentRuntimeService.abortSubSessions(sessionId);
		this.deps.permissionService.cancelPending(sessionId);
		this.deps.planService.cancelInteractions(sessionId, "Stopped by user");
		await managed.runtime.session.abort();
	}
}
