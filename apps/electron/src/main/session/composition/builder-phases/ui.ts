// CompositionBuilder phase
import { getAvailableModels } from "../../../models/model-queries.js";
import { ProjectDeletionService } from "../../../projects/project-deletion-service.js";
import { asPiSessionManager } from "../../../runtime-port/pi-session-ops.js";
import { MAX_NAME_LENGTH } from "../../constants.js";
import { SessionEventEffects } from "../../events/session-event-effects.js";
import { AttachmentService } from "../../services/attachment-service.js";
import { SessionControlService } from "../../services/session-control-service.js";
import { SessionHistoryService } from "../../services/session-history-service.js";
import { SessionLifecycleService } from "../../services/session-lifecycle-service.js";
import { SessionMessagingService } from "../../services/session-messaging-service.js";
import { SessionPermissionOrchestrator } from "../../services/session-permission-orchestrator.js";
import { SessionSettingsService } from "../../services/session-settings-service.js";
import { SkillManagementService } from "../../services/skill-management-service.js";
import type { CompositionBuilder } from "../builder-context.js";

export function buildUIPhase(b: CompositionBuilder): void {
	const host = b.req(b.host, "host");
	const modelRegistry = b.req(b.modelRegistry, "modelRegistry");

	b.sessionHistoryService = new SessionHistoryService({
		ensureRuntime: (sessionId) => b.req(b.runtimeLifecycle, "runtimeLifecycle").ensureRuntime(sessionId),
		createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent) =>
			b
				.req(b.runtimeLifecycle, "runtimeLifecycle")
				.createManagedRuntime(
					cwd,
					asPiSessionManager(manager),
					projectId,
					createdAt,
					startEvent as import("@earendil-works/pi-coding-agent").SessionStartEvent,
				),
		withSessionLock: (sessionId, task) => b.runtimeRegistry.withExclusive(sessionId, task),
		disposeRuntime: (sessionId, abort) =>
			b.req(b.runtimeLifecycle, "runtimeLifecycle").disposeRuntime(sessionId, abort),
		getRuntime: (sessionId) => host.getRuntime(sessionId),
		getSessionManager: (sessionId) => b.sessionManagerFor(sessionId),
		refreshProjectSessions: (projectId) => b.refreshProjectSessions(projectId),
		activateForkedSession: (projectId, sessionId) => {
			b.req(b.projectService, "projectService").setActiveId(projectId);
			b.activeSessionSelection.setCurrent(sessionId);
		},
		markSessionDefaultName: (sessionId) => {
			const scope = b.scopeRegistry.get(sessionId);
			if (scope) scope.isDefaultName = true;
		},
		emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason),
	});

	b.sessionControlService = new SessionControlService(
		{
			ensureRuntime: (sessionId) => b.req(b.runtimeLifecycle, "runtimeLifecycle").ensureRuntime(sessionId),
			getManagedRuntime: (sessionId) => b.runtimeRegistry.get(sessionId),
			getSessionManager: (sessionId) => b.sessionManagerFor(sessionId),
			sessionExists: (sessionId) => b.sessionExists(sessionId),
			setPendingModel: (sessionId, modelKey) => b.sessionPendingIntents.setModel(sessionId, modelKey),
			setPendingThinkingLevel: (sessionId, level) => b.sessionPendingIntents.setThinkingLevel(sessionId, level),
			updateStoredName: (sessionId, name) => {
				const stored = b.req(b.sessionCatalog, "sessionCatalog").get(sessionId);
				if (stored) stored.name = name;
				return stored;
			},
			closeDefaultNameGate: (sessionId) => {
				const scope = b.scopeRegistry.get(sessionId);
				if (scope) scope.isDefaultName = false;
			},
			emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
			emitSessionList: (projectId) => b.req(b.sessionNotifier, "sessionNotifier").emitSessionList(projectId),
			emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
		},
		modelRegistry,
		b.scopeRegistry,
		MAX_NAME_LENGTH,
	);

	// 必须先构造再注入：SessionLifecycleService / ProjectDeletionService 在下方
	// 以 `!` 取用该字段，若此行晚于注入点，null 会在运行期才暴露（validate 拦不住）。
	b.attachmentService = new AttachmentService();

	b.sessionLifecycleService = new SessionLifecycleService({
		host: {
			createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
				b
					.req(b.runtimeLifecycle, "runtimeLifecycle")
					.createManagedRuntime(
						cwd,
						asPiSessionManager(manager),
						projectId,
						createdAt,
						startEvent as import("@earendil-works/pi-coding-agent").SessionStartEvent | undefined,
						options,
					),
			disposeRuntime: (sessionId, abort) =>
				b.req(b.runtimeLifecycle, "runtimeLifecycle").disposeRuntime(sessionId, abort),
			refreshProjectSessions: (projectId) => b.refreshProjectSessions(projectId),
			getStoredSession: (sessionId) => b.req(b.sessionCatalog, "sessionCatalog").get(sessionId),
			removeStoredSession: (sessionId) => {
				b.req(b.sessionCatalog, "sessionCatalog").remove(sessionId);
			},
			emit: (event) => host.emit(event),
			emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
			emitSessionList: (projectId) => b.req(b.sessionNotifier, "sessionNotifier").emitSessionList(projectId),
			setActiveProjectId: (projectId) => b.req(b.projectService, "projectService").setActiveId(projectId),
			setActiveSessionId: (sessionId) => b.activeSessionSelection.setCurrent(sessionId),
			getActiveSessionId: () => b.activeSessionSelection.currentId,
		},
		projectService: b.req(b.projectService, "projectService"),
		draftIndex: b.draftIndex,
		runtimeRegistry: b.runtimeRegistry,
		scopeRegistry: b.scopeRegistry,
		subAgentRuntimeService: b.req(b.subAgentRuntimeService, "subAgentRuntimeService"),
		sessionInfoService: b.req(b.sessionInfoService, "sessionInfoService"),
		permissionService: b.req(b.permissionService, "permissionService"),
		planService: b.req(b.planService, "planService"),
		userSettings: b.req(b.userSettings, "userSettings"),
		modelRegistry,
		attachments: b.req(b.attachmentService, "attachmentService"),
		getAvailableModelsSync: () => getAvailableModels(modelRegistry),
		// Phase 2: abortAgent redirects through RuntimePort when live.
		runtimePort: b.req(b.runtimePort, "runtimePort"),
	});

	b.projectDeletionService = new ProjectDeletionService({
		projectService: b.req(b.projectService, "projectService"),
		sessionCatalog: b.req(b.sessionCatalog, "sessionCatalog"),
		draftIndex: b.draftIndex,
		runtimeRegistry: b.runtimeRegistry,
		disposeRuntime: (sessionId, abort) =>
			b.req(b.runtimeLifecycle, "runtimeLifecycle").disposeRuntime(sessionId, abort),
		workspaceFileService: b.workspaceFileServiceRef,
		workspaceTreeService: b.workspaceTreeServiceRef,
		emitSessionList: (projectId) => b.req(b.sessionNotifier, "sessionNotifier").emitSessionList(projectId),
		emitProjectList: () => b.req(b.sessionNotifier, "sessionNotifier").emitProjectList(),
		getActiveSessionId: () => b.activeSessionSelection.currentId,
		setActiveSessionId: (sessionId) => b.activeSessionSelection.setCurrent(sessionId),
		attachments: b.req(b.attachmentService, "attachmentService"),
		deleteScheduledTasksByProject: async (projectId) => b.schedulerRef.current?.deleteTasksByProject(projectId),
	});

	b.sessionMessagingService = new SessionMessagingService({
		getManagedRuntime: (sessionId) => b.runtimeRegistry.get(sessionId),
		ensureRuntime: (sessionId) => b.req(b.runtimeLifecycle, "runtimeLifecycle").ensureRuntime(sessionId),
		sessionExists: (sessionId) => b.sessionExists(sessionId),
		ensureMcpReady: async (projectId) => {
			await b.req(b.mcpManager, "mcpManager").ensureRequiredReady(projectId);
		},
		emitError: (error, sessionId) => b.req(b.sessionNotifier, "sessionNotifier").emitError(error, sessionId),
		attachments: b.req(b.attachmentService, "attachmentService"),
		// Phase 3b: prompt transport through RuntimePort (PiAdapter → session.prompt).
		runtimePort: b.req(b.runtimePort, "runtimePort"),
	});

	b.sessionPermissionOrchestrator = new SessionPermissionOrchestrator({
		host: {
			ensureRuntime: (sessionId) => b.req(b.runtimeLifecycle, "runtimeLifecycle").ensureRuntime(sessionId),
			emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
			sessionExists: (sessionId) => b.req(b.sessionCatalog, "sessionCatalog").get(sessionId) !== undefined,
		},
		eventBus: b.req(b.eventBus, "eventBus"),
		permissionService: b.req(b.permissionService, "permissionService"),
		planService: b.req(b.planService, "planService"),
		userSettings: b.req(b.userSettings, "userSettings"),
		modelRegistry: b.req(b.modelRegistry, "modelRegistry"),
	});

	b.sessionEventEffects = new SessionEventEffects({
		runtimeRegistry: b.runtimeRegistry,
		scopeRegistry: b.scopeRegistry,
		permissionService: b.req(b.permissionService, "permissionService"),
		planService: b.req(b.planService, "planService"),
		subAgentRuntimeService: b.req(b.subAgentRuntimeService, "subAgentRuntimeService"),
		subAgentRegistry: b.subAgentRegistry,
		autoTitleService: b.req(b.autoTitleService, "autoTitleService"),
		emitUsageUpdated: () => host.emit({ type: "usage:updated" }),
		getStoredProjectId: (sessionId) => b.req(b.sessionCatalog, "sessionCatalog").get(sessionId)?.projectId,
		refreshProjectSessions: (projectId) => b.refreshProjectSessions(projectId),
		emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
		emitSessionList: (projectId) => b.req(b.sessionNotifier, "sessionNotifier").emitSessionList(projectId),
		emitError: (error, sessionId) => b.req(b.sessionNotifier, "sessionNotifier").emitError(error, sessionId),
	});
	host.bindRuntimeServices({
		runtimeLifecycle: b.req(b.runtimeLifecycle, "runtimeLifecycle"),
		sessionNotifier: b.req(b.sessionNotifier, "sessionNotifier"),
		sessionEventEffects: b.sessionEventEffects,
		subAgentRuntimeService: b.req(b.subAgentRuntimeService, "subAgentRuntimeService"),
	});

	b.sessionSettingsService = new SessionSettingsService({
		userSettings: b.req(b.userSettings, "userSettings"),
		listProjects: () => b.req(b.projectService, "projectService").listProjects(),
		getActiveProject: () => b.req(b.projectService, "projectService").getActiveProject(),
		listSessionIds: () =>
			b
				.req(b.sessionInfoService, "sessionInfoService")
				.listAgents()
				.map((agent) => agent.id),
		listRuntimes: () => b.runtimeRegistry.values(),
		listRuntimeIds: () => b.runtimeRegistry.keys(),
		permissionService: b.req(b.permissionService, "permissionService"),
		sessionSubagentService: b.req(b.sessionSubagentService, "sessionSubagentService"),
		projectTrustDefaults: b.req(b.globalSettingsManager, "globalSettingsManager"),
	});

	b.skillManagementService = new SkillManagementService({
		runtimeRegistry: b.runtimeRegistry,
		selection: b.activeSessionSelection,
		globalSettingsManager: b.req(b.globalSettingsManager, "globalSettingsManager"),
		userSettings: b.req(b.userSettings, "userSettings"),
	});
}
