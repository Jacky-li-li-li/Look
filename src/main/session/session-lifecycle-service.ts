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
import type { IPermissionService, IPlanService } from "../core/contracts.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SubAgentRuntimeService } from "../services/subagent-runtime.js";
import type { UserSettingsStore } from "../settings/store.js";
import type { ManagedRuntime, RuntimeRegistry } from "./runtime-registry.js";
import type { SessionScopeRegistry } from "./scope-registry.js";
import type { StoredSession } from "./session-catalog.js";
import type { SessionInfoService } from "./session-info-service.js";

const MAX_NAME_LENGTH = 80;

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
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
	getAvailableModelsSync(): AvailableModel[];
}

export class SessionLifecycleService {
	constructor(private readonly deps: SessionLifecycleServiceDependencies) {}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider } | string,
	): Promise<string> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.deps.projectService.activeId;
		if (!projectId) throw new Error("No active project");
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		const managed = await this.deps.host.createManagedRuntime(
			project.cwd,
			SessionManager.create(project.cwd, ensureWorkspaceDir(project.name)),
			projectId,
			Date.now(),
		);
		const session = managed.runtime.session;
		session.setSessionName((input.name?.trim() || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH));

		if (!this.deps.userSettings.getAll().preferredModel) {
			const available = this.deps.getAvailableModelsSync();
			if (available.length > 0) {
				const first = available[0];
				const model = this.deps.modelRegistry.find(first.provider, first.id);
				if (model && this.deps.modelRegistry.hasConfiguredAuth(model)) {
					await session.setModel(model);
				}
			}
		}

		const scope = this.deps.scopeRegistry.get(session.sessionId);
		if (scope) scope.isDefaultName = true;
		if (input.imProvider) {
			const scope = this.deps.scopeRegistry.get(session.sessionId);
			if (scope) scope.imProvider = input.imProvider;
		}

		this.deps.host.setActiveProjectId(projectId);
		this.deps.host.setActiveSessionId(session.sessionId);
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
