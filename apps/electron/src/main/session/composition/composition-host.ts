import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MainToRendererEvent, ProjectInfo, SessionSnapshotEnvelope } from "@look/shared/types";
import type { ICompositionHost, IEventBus, IRuntimeStore, ISubAgentRuntimeHost } from "../../core/contracts.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { ActiveSessionSelection } from "../active-session-selection.js";
import type { RuntimeLifecycleCoordinator } from "../runtime-lifecycle-coordinator.js";
import type { RuntimeRegistry } from "../runtime-registry.js";
import type { SessionCatalog } from "../session-catalog.js";
import type { SessionEventEffects } from "../session-event-effects.js";
import type { SessionNotifier } from "../session-notifier.js";

/**
 * Internal callback adapter used while RuntimeManagerComposition is built.
 *
 * It owns only the dependencies required by construction-time consumers.
 * Services never retain SessionRuntimeManager, so no partially initialized
 * manager can escape from SessionRuntimeManager.create(). Late-bound services
 * are attached before the composition is returned to application code.
 */
export class CompositionHost implements ICompositionHost, IRuntimeStore, ISubAgentRuntimeHost {
	private runtimeLifecycle: Pick<RuntimeLifecycleCoordinator, "disposeRuntime"> | null = null;
	private sessionNotifier: Pick<
		SessionNotifier,
		"emitSessionState" | "emitTodoUpdate" | "emitSessionUpdated" | "emitContextUsage"
	> | null = null;
	private sessionEventEffects: Pick<
		SessionEventEffects,
		"onAgentEnd" | "onMessageEnd" | "onSubSessionAgentEnd"
	> | null = null;
	private subAgentRuntimeService: Pick<SubAgentRuntimeService, "hasCleanupTimer"> | null = null;

	constructor(
		private readonly eventBus: IEventBus,
		private readonly runtimeRegistry: RuntimeRegistry,
		private readonly sessionCatalog: SessionCatalog,
		private readonly projectService: Pick<ProjectService, "getActiveProject" | "listProjects">,
		private readonly activeSessionSelection: ActiveSessionSelection,
	) {}

	bindRuntimeServices(deps: {
		runtimeLifecycle: Pick<RuntimeLifecycleCoordinator, "disposeRuntime">;
		sessionNotifier: Pick<
			SessionNotifier,
			"emitSessionState" | "emitTodoUpdate" | "emitSessionUpdated" | "emitContextUsage"
		>;
		sessionEventEffects: Pick<SessionEventEffects, "onAgentEnd" | "onMessageEnd" | "onSubSessionAgentEnd">;
		subAgentRuntimeService: Pick<SubAgentRuntimeService, "hasCleanupTimer">;
	}): void {
		this.runtimeLifecycle = deps.runtimeLifecycle;
		this.sessionNotifier = deps.sessionNotifier;
		this.sessionEventEffects = deps.sessionEventEffects;
		this.subAgentRuntimeService = deps.subAgentRuntimeService;
	}

	emit(event: MainToRendererEvent): void {
		this.eventBus.emit(event);
	}

	onEvent(callback: (event: MainToRendererEvent) => void): () => void {
		return this.eventBus.onEvent(callback);
	}

	listProjects(): ProjectInfo[] {
		return this.projectService.listProjects();
	}

	getRuntime(sessionId: string): AgentSessionRuntime | undefined {
		return this.runtimeRegistry.get(sessionId)?.runtime;
	}

	getSession(sessionId: string): AgentSession | undefined {
		return this.runtimeRegistry.get(sessionId)?.runtime.session;
	}

	getSessionManager(sessionId: string): SessionManager | undefined {
		return this.runtimeRegistry.get(sessionId)?.binding.sessionManager;
	}

	getCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (!managed) throw new Error(`Session ${sessionId} is not live`);
		return managed.cwd;
	}

	getProjectRoot(): string {
		const project = this.projectService.getActiveProject();
		if (!project) throw new Error("No active project. Select a project folder first.");
		if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		return project.cwd;
	}

	getStoredSessionPath(sessionId: string): string | undefined {
		return this.sessionCatalog.get(sessionId)?.path;
	}

	getSessionCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.cwd;
		return this.sessionCatalog.get(sessionId)?.cwd ?? this.getProjectRoot();
	}

	hasCleanupTimer(sessionId: string): boolean {
		return this.requireService(this.subAgentRuntimeService, "sub-agent runtime service").hasCleanupTimer(sessionId);
	}

	async disposeRuntime(sessionId: string, abort?: boolean): Promise<void> {
		return this.requireService(this.runtimeLifecycle, "runtime lifecycle").disposeRuntime(sessionId, abort);
	}

	async onAgentEnd(sessionId: string, _willRetry: boolean): Promise<void> {
		return this.requireService(this.sessionEventEffects, "session event effects").onAgentEnd(sessionId);
	}

	async onMessageEnd(sessionId: string, message: AgentMessage): Promise<void> {
		return this.requireService(this.sessionEventEffects, "session event effects").onMessageEnd(sessionId, message);
	}

	onSubSessionAgentEnd(sessionId: string): void {
		this.requireService(this.sessionEventEffects, "session event effects").onSubSessionAgentEnd(sessionId);
	}

	emitSessionState(
		sessionId: string | undefined,
		reason: SessionSnapshotEnvelope["reason"],
		willRetry?: boolean,
	): void {
		this.requireService(this.sessionNotifier, "session notifier").emitSessionState(
			sessionId ?? this.activeSessionSelection.currentId,
			reason,
			willRetry,
		);
	}

	emitTodoUpdate(sessionId: string): void {
		this.requireService(this.sessionNotifier, "session notifier").emitTodoUpdate(sessionId);
	}

	emitSessionUpdated(sessionId: string): void {
		this.requireService(this.sessionNotifier, "session notifier").emitSessionUpdated(sessionId);
	}

	emitContextUsage(sessionId: string): void {
		this.requireService(this.sessionNotifier, "session notifier").emitContextUsage(sessionId);
	}

	private requireService<T>(service: T | null, name: string): T {
		if (!service) throw new Error(`CompositionHost ${name} is not bound`);
		return service;
	}
}
