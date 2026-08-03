import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	SessionManager,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { MainToRendererEvent, SessionSnapshotEnvelope } from "@look/shared/types";
import type { IPermissionService, IPlanService, ISessionScopeRegistry } from "../../core/contracts.js";
import type { AutoTitleService } from "../../services/auto-title.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { SessionEventProcessor } from "../events/session-event-processor.js";
import type { SessionNotifier } from "../events/session-notifier.js";
import type { ActiveSessionSelection } from "../scope/active-session-selection.js";
import type { StoredSession } from "../services/session-catalog.js";
import type { SessionPermissionOrchestrator } from "../services/session-permission-orchestrator.js";
import type { SessionSubagentService } from "../services/session-subagent-service.js";
import type { SubAgentRegistry } from "../subagent-registry.js";
import type { RuntimeFactoryOptions, SessionRuntimeFactory } from "./runtime-factory.js";
import type { ManagedRuntime, RuntimeRegistry, RuntimeSessionBinding } from "./runtime-registry.js";

interface RuntimeLifecycleEvents {
	emit(event: MainToRendererEvent): void;
	emitSessionState(sessionId: string, reason?: SessionSnapshotEnvelope["reason"]): void;
	emitSessionList(projectId: string): void;
	emitProjectList(): void;
}

export interface RuntimeLifecycleCoordinatorOptions {
	runtimeFactory: Pick<SessionRuntimeFactory, "create">;
	runtimeRegistry: RuntimeRegistry;
	scopeRegistry: ISessionScopeRegistry;
	permissionService: Pick<
		IPermissionService,
		"restoreFromSession" | "cancelPending" | "persistIfDirty" | "disposeSession"
	>;
	planService: Pick<
		IPlanService,
		"restoreToolSnapshot" | "syncToolState" | "cancelInteractions" | "persistToolSnapshotIfDirty" | "disposeSession"
	>;
	sessionPermissionOrchestrator: Pick<SessionPermissionOrchestrator, "disposeSession">;
	subAgentRegistry: Pick<SubAgentRegistry, "hasPending" | "unregister">;
	subAgentRuntimeService: Pick<
		SubAgentRuntimeService,
		"finalizeSubSession" | "cancelSubSessionCleanup" | "finalizePendingChildren"
	>;
	autoTitleService: Pick<AutoTitleService, "dispose">;
	eventProcessor: Pick<SessionEventProcessor, "dispose">;
	sessionSubagentService: Pick<SessionSubagentService, "applyDefaultOnBind" | "clearSession">;
	sessionNotifier: Pick<SessionNotifier, "disposeSession">;
	selection: ActiveSessionSelection;
	getStoredSession(sessionId: string): StoredSession | undefined;
	openSessionManager(stored: StoredSession): SessionManager;
	handleSessionEvent(sessionId: string, event: AgentSessionEvent): Promise<void>;
	setActiveProjectId(projectId: string): void;
	getActiveProjectId(): string | null;
	refreshProjectSessions(projectId: string): Promise<unknown>;
	events: RuntimeLifecycleEvents;
}

/**
 * Owns every mutation of the live runtime registry and the lifecycle-bound
 * permission, plan, scope, subscription, and selection state around it.
 */
export class RuntimeLifecycleCoordinator {
	private readonly disposals = new Map<string, Promise<void>>();
	private readonly creationTargets = new Map<string, { cwd: string; projectId: string }>();
	/** 最近一次向渲染端广播过 active project 的项目 id（用于 projectChanged 判定）。 */
	private lastBroadcastProjectId: string | null;

	constructor(private readonly options: RuntimeLifecycleCoordinatorOptions) {
		// 启动时内部 activeProjectId 与渲染端同步（由 project 路由恢复），以它为基线。
		this.lastBroadcastProjectId = options.getActiveProjectId();
	}

	async createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt = Date.now(),
		sessionStartEvent?: SessionStartEvent,
		factoryOptions?: RuntimeFactoryOptions,
	): Promise<ManagedRuntime> {
		const sessionId = sessionManager.getSessionId();
		const disposing = this.disposals.get(sessionId);
		if (disposing) await disposing;
		const existing = this.options.runtimeRegistry.get(sessionId);
		if (existing) {
			this.assertRuntimeTarget(existing, cwd, projectId);
			return existing;
		}
		const pendingTarget = this.creationTargets.get(sessionId);
		if (pendingTarget && (pendingTarget.cwd !== cwd || pendingTarget.projectId !== projectId)) {
			throw new Error(`Session ${sessionId} is already initializing for another project or cwd`);
		}
		const target = pendingTarget ?? { cwd, projectId };
		const ownsTarget = !pendingTarget;
		if (ownsTarget) this.creationTargets.set(sessionId, target);
		try {
			return await this.options.runtimeRegistry.getOrCreate(sessionId, async () => {
				const runtime = await this.options.runtimeFactory.create(
					cwd,
					sessionManager,
					sessionStartEvent,
					factoryOptions,
				);
				try {
					return await this.bindRuntime(runtime, projectId, createdAt);
				} catch (error) {
					await this.discardFailedCreation(runtime);
					throw error;
				}
			});
		} finally {
			if (ownsTarget && this.creationTargets.get(sessionId) === target) {
				this.creationTargets.delete(sessionId);
			}
		}
	}

	async ensureRuntime(sessionId: string): Promise<ManagedRuntime> {
		const disposing = this.disposals.get(sessionId);
		if (disposing) await disposing;
		const existing = this.options.runtimeRegistry.get(sessionId);
		if (existing) return existing;
		const stored = this.options.getStoredSession(sessionId);
		if (!stored) throw new Error(`Session ${sessionId} not found`);
		return this.createManagedRuntime(
			stored.cwd,
			this.options.openSessionManager(stored),
			stored.projectId,
			stored.created.getTime(),
		);
	}

	async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		const existing = this.disposals.get(sessionId);
		if (existing) return existing;
		const disposal = this.performDisposeRuntime(sessionId, abort);
		this.disposals.set(sessionId, disposal);
		try {
			await disposal;
		} finally {
			if (this.disposals.get(sessionId) === disposal) this.disposals.delete(sessionId);
		}
	}

	async disposeAllRuntimes(): Promise<void> {
		await this.options.runtimeRegistry.awaitAllInitializations();
		const sessionIds = [...this.options.runtimeRegistry.keys()];
		await Promise.all(sessionIds.map((sessionId) => this.disposeRuntime(sessionId, true)));
	}

	async activateSession(sessionId: string, opts?: { skipSnapshot?: boolean }): Promise<void> {
		if (this.options.selection.isCurrent(sessionId) && this.options.runtimeRegistry.has(sessionId)) {
			// 渲染端已在顶部打开且持有快照时（skipSnapshot），只确认 selection 已是最新，
			// 不重发全量会话历史。避免渲染端 entries 换新引用 → timeline 重算 → 全部消息重渲染。
			if (opts?.skipSnapshot) {
				this.refreshActiveProjectSessions(sessionId);
			} else {
				this.options.events.emitSessionState(sessionId, "activate");
			}
			// 用户已查看该会话（已读）——任何激活路径都通知岛清除未读。
			this.options.events.emit({ type: "session:activated", agentId: sessionId });
			return;
		}
		// 记录调用前是否已有 live runtime：仅当 runtime 可复用且渲染端持有快照（skipSnapshot）
		// 时才可跳过快照重发；若 runtime 是新创建的（从磁盘恢复），渲染端没有可用数据，必须发快照。
		const hadRuntime = this.options.runtimeRegistry.has(sessionId);
		const managed = await this.ensureRuntime(sessionId);
		// 同一项目内切换会话：项目列表与会话列表都没有变化，跳过磁盘扫描和
		// project:list / project:active-changed 事件风暴（快速连点时的卡顿主因）。
		// 仅跨项目切换才需要刷新项目级状态。
		// 注意：以「最近一次已广播的项目」为基准，而非内部 activeProjectId——
		// 新建会话路径（session-lifecycle-service）会直接 setActiveProjectId 但不广播，
		// 若用内部值判定，会把这种「渲染端还不知情」的切换误判为同项目，
		// 导致渲染端项目高亮/文件面板/最后活跃项目持久化永久漂移且不自愈。
		const projectChanged = this.lastBroadcastProjectId !== managed.projectId;
		this.options.selection.setCurrent(sessionId);
		this.options.subAgentRuntimeService.cancelSubSessionCleanup(sessionId);
		if (projectChanged) {
			this.options.setActiveProjectId(managed.projectId);
			await this.options.refreshProjectSessions(managed.projectId);
			this.options.events.emitProjectList();
			this.options.events.emit({ type: "project:active-changed", projectId: managed.projectId });
			this.lastBroadcastProjectId = managed.projectId;
		}
		if (opts?.skipSnapshot && hadRuntime) {
			// 轻量激活：仅跨项目切换时需要刷新新项目的会话列表；同项目内列表没变，跳过。
			if (projectChanged) {
				this.options.events.emitSessionList(managed.projectId);
			}
		} else {
			this.options.events.emitSessionState(sessionId);
		}
		// 用户已查看该会话（已读）——任何激活路径都通知岛清除未读。
		this.options.events.emit({ type: "session:activated", agentId: sessionId });
	}

	/** skipSnapshot 命中 current 短路时，仍刷新该会话所在项目的侧边栏列表。 */
	private refreshActiveProjectSessions(sessionId: string): void {
		const info = this.options.getStoredSession(sessionId);
		const projectId = info?.projectId;
		if (!projectId) return;
		this.options.events.emitSessionList(projectId);
	}

	private async bindRuntime(
		runtime: AgentSessionRuntime,
		projectId: string,
		createdAt: number,
	): Promise<ManagedRuntime> {
		const session = runtime.session;
		const existing = this.options.runtimeRegistry.get(session.sessionId);
		if (existing) throw new Error(`Session ${session.sessionId} already has a live runtime`);
		this.restoreSessionState(session);
		await this.bindExtensions(session);
		const managed: ManagedRuntime = {
			runtime,
			projectId,
			cwd: runtime.cwd,
			createdAt,
			binding: this.bindingFor(session),
			unsubscribe: () => {},
		};
		this.options.scopeRegistry.acquire(session.sessionId, projectId);
		managed.unsubscribe = this.subscribe(session);
		runtime.setBeforeSessionInvalidate(() => {
			this.reportCleanupErrors(managed.binding.sessionId, this.persistBindingState(managed.binding));
		});
		runtime.setRebindSession(async (nextSession) => this.rebindRuntime(managed, nextSession));
		this.options.runtimeRegistry.set(session.sessionId, managed);
		this.options.planService.syncToolState(session.sessionId);
		this.options.sessionSubagentService.applyDefaultOnBind(session.sessionId, session);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
		return managed;
	}

	private async rebindRuntime(managed: ManagedRuntime, session: AgentSession): Promise<void> {
		const { runtime } = managed;
		const previousBinding = managed.binding;
		const previousSessionId = previousBinding.sessionId;
		if (this.options.runtimeRegistry.get(previousSessionId) !== managed) {
			throw new Error("Runtime replacement lost its registry entry");
		}
		const nextBinding = this.bindingFor(session);
		if (session.sessionId !== previousSessionId) {
			await this.options.runtimeRegistry.awaitInitialization(session.sessionId);
		}
		const collision = this.options.runtimeRegistry.get(session.sessionId);
		if (session.sessionId !== previousSessionId && collision) {
			await this.discardReboundRuntime(previousBinding, nextBinding, managed, {
				cleanupPrevious: true,
				cleanupNext: false,
			});
			throw new Error(`Session ${session.sessionId} already has a live runtime`);
		}
		if (runtime.cwd !== managed.cwd) {
			await this.discardReboundRuntime(previousBinding, nextBinding, managed, {
				cleanupPrevious: true,
				cleanupNext: false,
			});
			throw new Error(`Runtime cwd cannot change during session replacement: ${managed.cwd} -> ${runtime.cwd}`);
		}

		managed.unsubscribe();
		managed.unsubscribe = () => {};
		this.reportCleanupErrors(
			previousSessionId,
			this.cleanupSessionState(previousBinding, "Runtime was replaced", true),
		);

		this.options.runtimeRegistry.delete(previousSessionId);
		managed.binding = nextBinding;
		this.options.runtimeRegistry.set(session.sessionId, managed);
		this.options.scopeRegistry.acquire(session.sessionId, managed.projectId);
		this.restoreSessionState(session);
		try {
			await this.bindExtensions(session);
			managed.unsubscribe = this.subscribe(session);
			this.options.planService.syncToolState(session.sessionId);
			this.options.sessionSubagentService.applyDefaultOnBind(session.sessionId, session);
		} catch (error) {
			await this.discardReboundRuntime(previousBinding, nextBinding, managed, {
				cleanupPrevious: false,
				cleanupNext: true,
			});
			throw error;
		}
		this.options.selection.replaceIfCurrent(previousSessionId, session.sessionId);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
	}

	private assertRuntimeTarget(managed: ManagedRuntime, cwd: string, projectId: string): void {
		if (managed.cwd !== cwd || managed.projectId !== projectId) {
			throw new Error(`Session ${managed.binding.sessionId} is already live for another project or cwd`);
		}
	}

	private async discardFailedCreation(runtime: AgentSessionRuntime): Promise<void> {
		const sessionId = runtime.session.sessionId;
		const managed = this.options.runtimeRegistry.get(sessionId);
		if (managed && managed.runtime !== runtime) {
			await runtime.dispose().catch((error) => {
				console.error("[Look] Failed to dispose colliding runtime after initialization failure:", error);
			});
			return;
		}
		if (managed?.runtime === runtime) {
			managed.unsubscribe();
			this.options.runtimeRegistry.delete(sessionId);
		}
		this.reportCleanupErrors(
			sessionId,
			this.cleanupSessionState(this.bindingFor(runtime.session), "Runtime initialization failed", false),
		);
		await runtime.dispose().catch((error) => {
			console.error("[Look] Failed to dispose runtime after initialization failure:", error);
		});
	}

	private async discardReboundRuntime(
		previousBinding: RuntimeSessionBinding,
		nextBinding: RuntimeSessionBinding,
		managed: ManagedRuntime,
		cleanup: { cleanupPrevious: boolean; cleanupNext: boolean },
	): Promise<void> {
		const previousSessionId = previousBinding.sessionId;
		const nextSessionId = nextBinding.sessionId;
		managed.unsubscribe();
		this.options.runtimeRegistry.delete(previousSessionId);
		if (this.options.runtimeRegistry.get(nextSessionId)?.runtime === managed.runtime) {
			this.options.runtimeRegistry.delete(nextSessionId);
		}
		if (cleanup.cleanupPrevious) {
			this.reportCleanupErrors(
				previousSessionId,
				this.cleanupSessionState(previousBinding, "Runtime replacement failed", true),
			);
		}
		if (cleanup.cleanupNext) {
			this.reportCleanupErrors(
				nextSessionId,
				this.cleanupSessionState(nextBinding, "Runtime replacement failed", false),
			);
		}
		this.options.selection.clearIfCurrent(previousSessionId);
		if (cleanup.cleanupNext) this.options.selection.clearIfCurrent(nextSessionId);
		await managed.runtime.dispose().catch((error) => {
			console.error("[Look] Failed to dispose invalid rebound runtime:", error);
		});
	}

	private cleanupSessionState(binding: RuntimeSessionBinding, reason: string, persist: boolean): unknown[] {
		const { sessionId, sessionManager } = binding;
		const errors: unknown[] = [];
		const attempt = (task: () => void) => {
			try {
				task();
			} catch (error) {
				errors.push(error);
			}
		};
		attempt(() => this.options.permissionService.cancelPending(sessionId));
		attempt(() => this.options.planService.cancelInteractions(sessionId, reason));
		if (persist) {
			attempt(() => this.options.permissionService.persistIfDirty(sessionId, sessionManager));
			attempt(() => this.options.planService.persistToolSnapshotIfDirty(sessionId, sessionManager));
		}
		attempt(() => this.options.autoTitleService.dispose(sessionId));
		const scope = this.options.scopeRegistry.get(sessionId);
		if (scope) scope.isDefaultName = false;
		attempt(() => this.options.subAgentRuntimeService.cancelSubSessionCleanup(sessionId));
		attempt(() => this.options.permissionService.disposeSession(sessionId));
		attempt(() => this.options.planService.disposeSession(sessionId));
		attempt(() => this.options.sessionPermissionOrchestrator.disposeSession(sessionId));
		if (scope) attempt(() => this.options.eventProcessor.dispose(sessionId));
		attempt(() => this.options.scopeRegistry.release(sessionId));
		attempt(() => this.options.sessionSubagentService.clearSession(sessionId));
		attempt(() => this.options.sessionNotifier.disposeSession(sessionId));
		return errors;
	}

	private reportCleanupErrors(sessionId: string, errors: unknown[]): void {
		for (const error of errors) {
			console.error(`[Look] Failed to clean up session state for ${sessionId}:`, error);
		}
	}

	private async performDisposeRuntime(sessionId: string, abort: boolean): Promise<void> {
		await this.options.runtimeRegistry.awaitInitialization(sessionId);
		const managed = this.options.runtimeRegistry.get(sessionId);
		if (!managed) return;
		const errors: unknown[] = [];
		const attempt = (task: () => void) => {
			try {
				task();
			} catch (error) {
				errors.push(error);
			}
		};
		attempt(() => this.options.permissionService.cancelPending(sessionId));
		attempt(() => this.options.planService.cancelInteractions(sessionId, "Session runtime was disposed"));
		let hasPending = false;
		try {
			hasPending = this.options.subAgentRegistry.hasPending(sessionId);
		} catch (error) {
			errors.push(error);
		}
		if (hasPending) {
			// 父会话销毁 → 自身作为子会话被中止（forceAborted，而不是 forceFailed）：
			// forceFailed 仅用于运行/预检失败，避免“中止”被误报成“失败”。
			attempt(() => this.options.subAgentRuntimeService.finalizeSubSession(sessionId, false, true));
		}
		attempt(() => this.options.subAgentRuntimeService.finalizePendingChildren(sessionId));
		attempt(() => this.options.subAgentRegistry.unregister(sessionId));
		if (abort && managed.runtime.session.isStreaming) {
			try {
				await managed.runtime.session.abort();
			} catch (error) {
				errors.push(error);
			}
		}
		attempt(() => this.options.permissionService.persistIfDirty(sessionId, managed.binding.sessionManager));
		attempt(() => this.options.planService.persistToolSnapshotIfDirty(sessionId, managed.binding.sessionManager));
		attempt(() => this.options.autoTitleService.dispose(sessionId));
		const scope = this.options.scopeRegistry.get(sessionId);
		if (scope) scope.isDefaultName = false;
		attempt(() => this.options.subAgentRuntimeService.cancelSubSessionCleanup(sessionId));
		attempt(() => managed.unsubscribe());
		this.options.runtimeRegistry.delete(sessionId);
		attempt(() => this.options.permissionService.disposeSession(sessionId));
		attempt(() => this.options.planService.disposeSession(sessionId));
		attempt(() => this.options.sessionPermissionOrchestrator.disposeSession(sessionId));
		if (scope) attempt(() => this.options.eventProcessor.dispose(sessionId));
		attempt(() => this.options.scopeRegistry.release(sessionId));
		attempt(() => this.options.sessionSubagentService.clearSession(sessionId));
		attempt(() => this.options.sessionNotifier.disposeSession(sessionId));
		this.options.runtimeRegistry.releaseExclusive(sessionId);
		// If the disposed session was the currently selected one, clear the
		// selection so the renderer never holds a dangling active-session id.
		this.options.selection.clearIfCurrent(sessionId);
		try {
			await managed.runtime.dispose();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, `Failed to fully dispose runtime ${sessionId}`);
		}
	}

	private restoreSessionState(session: AgentSession): void {
		this.options.permissionService.restoreFromSession(session.sessionId, session.sessionManager);
		this.options.planService.restoreToolSnapshot(session.sessionId, session.sessionManager);
	}

	private bindingFor(session: AgentSession): RuntimeSessionBinding {
		return { sessionId: session.sessionId, sessionManager: session.sessionManager };
	}

	private persistBindingState(binding: RuntimeSessionBinding): unknown[] {
		const errors: unknown[] = [];
		try {
			this.options.permissionService.persistIfDirty(binding.sessionId, binding.sessionManager);
		} catch (error) {
			errors.push(error);
		}
		try {
			this.options.planService.persistToolSnapshotIfDirty(binding.sessionId, binding.sessionManager);
		} catch (error) {
			errors.push(error);
		}
		return errors;
	}

	/**
	 * Bind all registered extensions to the session.
	 *
	 * Each extension receives an `ExtensionAPI` object that includes:
	 * - `on()` — subscribe to session lifecycle events
	 * - `registerTool()` — register tools the LLM can call
	 * - `registerProvider(provider)` / `registerProvider(name, config)` — register
	 *   custom model providers with full native support (streamSimple, oauth,
	 *   refreshModels). See pi docs/custom-provider.md for details.
	 */
	private bindExtensions(session: AgentSession): Promise<void> {
		return session.bindExtensions({
			mode: "rpc",
			onError: (error) =>
				this.options.events.emit({
					type: "error",
					agentId: session.sessionId,
					message: String(error),
				}),
		});
	}

	private subscribe(session: AgentSession): () => void {
		return session.subscribe(async (event) => {
			try {
				// await 让 agent_end 分支能在快照发出前完成 duration 持久化。
				await this.options.handleSessionEvent(session.sessionId, event);
			} catch (error) {
				console.error("[Look] Error in session event handler:", error);
			}
		});
	}

	private emitRuntimeDiagnostics(sessionId: string, runtime: AgentSessionRuntime): void {
		for (const diagnostic of runtime.diagnostics) {
			if (diagnostic.type === "error" || diagnostic.type === "warning") {
				this.options.events.emit({ type: "error", agentId: sessionId, message: diagnostic.message });
			}
		}
		if (runtime.modelFallbackMessage) {
			this.options.events.emit({ type: "error", agentId: sessionId, message: runtime.modelFallbackMessage });
		}
	}
}
