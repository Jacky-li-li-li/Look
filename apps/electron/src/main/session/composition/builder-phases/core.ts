// CompositionBuilder phase
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentDefinitionService } from "../../../agents/definition-service.js";
import { getAvailableModels } from "../../../models/model-queries.js";
import { PlanService } from "../../../permissions/plan.js";
import { MAX_NAME_LENGTH } from "../../constants.js";
import { RuntimeLifecycleCoordinator } from "../../runtime/runtime-lifecycle-coordinator.js";
import { ensureSessionModel } from "../../services/session-lifecycle-service.js";
import { SessionSubagentService } from "../../services/session-subagent-service.js";
import type { CompositionBuilder } from "../builder-context.js";
import { MAX_SUBAGENT_DEPTH } from "../builder-context.js";

export function buildCorePhase(b: CompositionBuilder): void {
	const host = b.req(b.host, "host");
	const modelRegistry = b.req(b.modelRegistry, "modelRegistry");

	// planService — created first; sessionPermissionOrchestrator is forward-referenced via closure
	b.planService = new PlanService(host, host, b.req(b.permissionService, "permissionService"), async (sessionId) => {
		await b.req(b.sessionPermissionOrchestrator, "sessionPermissionOrchestrator").applyMode(sessionId, "always", {
			internal: true,
			updateDefault: false,
		});
	});

	// agentDefinitionService — sessionSubagentService forward-referenced via closure
	b.agentDefinitionService = new AgentDefinitionService(() =>
		b.req(b.sessionSubagentService, "sessionSubagentService").reloadAllSessionsForAgents(),
	);

	// sessionSubagentService — runtimeLifecycle forward-referenced via closures in host
	b.sessionSubagentService = new SessionSubagentService({
		host: {
			createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
				b
					.req(b.runtimeLifecycle, "runtimeLifecycle")
					.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent, options),
			disposeRuntime: (sessionId, abort) =>
				b.req(b.runtimeLifecycle, "runtimeLifecycle").disposeRuntime(sessionId, abort),
			getManagedRuntime: (sessionId) => b.runtimeRegistry.get(sessionId),
			reloadSession: async (sessionId) => {
				const managed = b.runtimeRegistry.get(sessionId);
				if (managed) await managed.runtime.session.reload();
			},
			listRuntimeIds: () => b.runtimeRegistry.keys(),
			getProjectInfo: (projectId) => b.req(b.projectService, "projectService").getProjectInfo(projectId),
			emit: (event) => host.emit(event),
			emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
			getScope: (sessionId) => b.scopeRegistry.get(sessionId),
			acquireScope: (sessionId, projectId) => b.scopeRegistry.acquire(sessionId, projectId),
			runtimeInfo: (sessionId) => b.req(b.sessionInfoService, "sessionInfoService").getAgentInfo(sessionId),
		},
		modelRegistry,
		subAgentRegistry: b.subAgentRegistry,
		subAgentRuntimeService: b.req(b.subAgentRuntimeService, "subAgentRuntimeService"),
		permissionService: b.req(b.permissionService, "permissionService"),
		planService: b.planService,
		userSettings: b.req(b.userSettings, "userSettings"),
		agentDefinitionService: b.agentDefinitionService,
		maxSubagentDepth: MAX_SUBAGENT_DEPTH,
		maxNameLength: MAX_NAME_LENGTH,
	});
	b.sessionSubagentService.loadDefaultFromSettings();

	// runtimeLifecycle — references sessionSubagentService (already assigned)
	b.runtimeLifecycle = new RuntimeLifecycleCoordinator({
		ensureSessionModel: (session) =>
			ensureSessionModel(session, {
				getAvailableModelsSync: () => getAvailableModels(b.req(b.modelRegistry, "modelRegistry")),
				modelRegistry: b.req(b.modelRegistry, "modelRegistry"),
				userSettings: b.req(b.userSettings, "userSettings"),
			}),
		runtimeFactory: b.req(b.runtimeFactory, "runtimeFactory"),
		runtimeRegistry: b.runtimeRegistry,
		scopeRegistry: b.scopeRegistry,
		permissionService: b.req(b.permissionService, "permissionService"),
		planService: b.planService,
		sessionPermissionOrchestrator: {
			disposeSession: (sessionId) => b.sessionPermissionOrchestrator?.disposeSession(sessionId),
		},
		subAgentRegistry: b.subAgentRegistry,
		subAgentRuntimeService: b.req(b.subAgentRuntimeService, "subAgentRuntimeService"),
		autoTitleService: b.req(b.autoTitleService, "autoTitleService"),
		eventProcessor: b.req(b.eventProcessor, "eventProcessor"),
		sessionSubagentService: b.sessionSubagentService,
		sessionNotifier: b.req(b.sessionNotifier, "sessionNotifier"),
		selection: b.activeSessionSelection,
		getStoredSession: (sessionId) => b.req(b.sessionCatalog, "sessionCatalog").get(sessionId),
		getDraft: (sessionId) => {
			const entry = b.draftIndex.get(sessionId);
			if (!entry) return undefined;
			const project = b.req(b.projectService, "projectService").getProjectInfo(entry.projectId);
			if (!project?.valid) return undefined;
			return { cwd: project.cwd, projectId: entry.projectId, name: entry.name };
		},
		emitSessionPreview: (sessionId, stored) =>
			b.req(b.sessionNotifier, "sessionNotifier").emitSessionPreview(sessionId, stored),
		openSessionManager: (stored) => SessionManager.open(stored.path),
		pendingIntents: b.sessionPendingIntents,
		resolveModel: (modelKey) => {
			const slash = modelKey.indexOf("/");
			if (slash <= 0) return undefined;
			return b.req(b.modelRegistry, "modelRegistry").find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		},
		// runtime 绑定完成 → flush 挂起消息（messaging service 在 Phase 5 就位，
		// 闭包延迟解析；flush 内部自管异常，不影响绑定路径）。
		onSessionBound: (managed) => {
			// Phase 2: associate live session with the default RuntimePort (multi-engine later).
			const port = b.runtimePort;
			if (port) b.runtimePortRegistry?.bind(managed.binding.sessionId, port);
			void b.sessionMessagingService?.flushPending(managed);
		},
		onSessionDisposed: (sessionId) => {
			b.runtimePortRegistry?.unbind(sessionId);
			b.sessionMessagingService?.disposeSession(sessionId);
		},
		associateRuntimePort: (sessionId) => {
			const port = b.runtimePort;
			if (port) b.runtimePortRegistry?.bind(sessionId, port);
		},
		handleSessionEvent: (sessionId, event) => b.req(b.eventProcessor, "eventProcessor").handle(sessionId, event),
		setActiveProjectId: (projectId) => b.req(b.projectService, "projectService").setActiveId(projectId),
		getActiveProjectId: () => b.req(b.projectService, "projectService").activeId,
		refreshProjectSessions: (projectId) => b.refreshProjectSessions(projectId),
		events: {
			emit: (event) => host.emit(event),
			emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
			emitSessionList: (projectId) => b.req(b.sessionNotifier, "sessionNotifier").emitSessionList(projectId),
			emitProjectList: () => b.req(b.sessionNotifier, "sessionNotifier").emitProjectList(),
		},
	});
}
