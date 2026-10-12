import { existsSync } from "node:fs";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type ModelRegistry,
	type ModelRuntime,
	type ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getLookDir } from "@look/shared/look-storage";
import type { ThinkingLevel } from "@look/shared/types";
import type { AgentDefinitionService } from "../../agents/definition-service.js";
import type { BrowserService } from "../../browser/browser-service.js";
import type { ComputerUseService } from "../../computer-use/computer-use-service.js";
import type { MCPManager } from "../../mcp/manager.js";
import { getAvailableModels } from "../../models/model-queries.js";
import type { PlanService } from "../../permissions/plan.js";
import type { PermissionService } from "../../permissions/service.js";
import type { ProjectDeletionService } from "../../projects/project-deletion-service.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { PiAdapter, RuntimePort, RuntimePortRegistry } from "../../runtime-port/index.js";
import type { SchedulerService } from "../../scheduler/scheduler-service.js";
import type { EncryptedCredentialStore } from "../../security/secrets.js";
import type { AutoTitleService } from "../../services/auto-title.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { CustomProvidersStore } from "../../settings/custom-providers.js";
import type { PromptStore } from "../../settings/prompt-store.js";
import type { UserSettingsStore } from "../../settings/store.js";
import type { TranscriptionService } from "../../transcribe/transcription-service.js";
import type { WorkspaceFileService } from "../../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../../workspace/workspace-tree-service.js";
import { SessionEventBus } from "../events/session-event-bus.js";
import type { SessionEventEffects } from "../events/session-event-effects.js";
import type { SessionEventProcessor } from "../events/session-event-processor.js";
import type { SessionNotifier } from "../events/session-notifier.js";
import type { SessionRuntimeFactory } from "../runtime/runtime-factory.js";
import type { RuntimeLifecycleCoordinator } from "../runtime/runtime-lifecycle-coordinator.js";
import { RuntimeRegistry } from "../runtime/runtime-registry.js";
import { ActiveSessionSelection } from "../scope/active-session-selection.js";
import { SessionScopeRegistry } from "../scope/scope-registry.js";
import { SessionPendingIntents } from "../scope/session-pending-intents.js";
import type { AttachmentService } from "../services/attachment-service.js";
import { type ExpectedSessionDefaults, resolveExpectedSessionDefaults } from "../services/expected-session-defaults.js";
import type { ProjectApplicationService } from "../services/project-application-service.js";
import type { ProjectRuntimeService } from "../services/project-runtime-service.js";
import type { SessionCatalog } from "../services/session-catalog.js";
import type { SessionControlService } from "../services/session-control-service.js";
import { SessionDraftIndex } from "../services/session-draft-index.js";
import type { SessionHistoryService } from "../services/session-history-service.js";
import type { SessionInfoService } from "../services/session-info-service.js";
import type { SessionLifecycleService } from "../services/session-lifecycle-service.js";
import type { SessionMessagingService } from "../services/session-messaging-service.js";
import type { SessionPermissionOrchestrator } from "../services/session-permission-orchestrator.js";
import type { SessionSettingsService } from "../services/session-settings-service.js";
import type { SessionSubagentService } from "../services/session-subagent-service.js";
import type { SkillManagementService } from "../services/skill-management-service.js";
import { SubAgentRegistry } from "../subagent-registry.js";
import type { CompositionHost } from "./composition-host.js";

export const MAX_SUBAGENT_DEPTH = 5;

/**
 * Mutable builder that orchestrates service creation in dependency order.
 * All fields start null; phase methods populate them. Closures resolve
 * forward references naturally at call time.
 */
export class CompositionBuilder {
	/**
	 * 启动期必填字段：用带字段名的错误取代非空断言，避免下游出现
	 * 模糊的 `undefined is not a function`。闭包在 Phase 4 之后才调用，
	 * 因此在闭包体内使用同样安全。
	 */
	/** @internal */
	req<T>(value: T | null | undefined, name: string): T {
		if (value === null || value === undefined) {
			throw new Error(`[CompositionBuilder] "${name}" is not initialized yet`);
		}
		return value;
	}

	// ── Owned by the builder (not passed in) ──
	readonly eventBus = new SessionEventBus();
	readonly runtimeRegistry = new RuntimeRegistry();
	readonly scopeRegistry = new SessionScopeRegistry();
	readonly subAgentRegistry = new SubAgentRegistry();
	readonly activeSessionSelection = new ActiveSessionSelection();
	/** 会话级挂起意图（模型/思考）：runtime 未就绪时的切换暂存，物化时消费。 */
	readonly sessionPendingIntents = new SessionPendingIntents();

	// ── Infra (sync) ──
	trustStore: ProjectTrustStore | null = null;
	globalSettingsManager: SettingsManager | null = null;
	projectService: ProjectService | null = null;
	userSettings: UserSettingsStore | null = null;
	permissionService: PermissionService | null = null;
	promptStore: PromptStore | null = null;
	mcpManager: MCPManager | null = null;
	computerUseService: ComputerUseService | null = null;
	browserService: BrowserService | null = null;
	transcribeService: TranscriptionService | null = null;
	sessionCatalog: SessionCatalog | null = null;
	draftIndex: SessionDraftIndex = new SessionDraftIndex();
	projectRuntimeService: ProjectRuntimeService | null = null;
	sessionInfoService: SessionInfoService | null = null;
	sessionNotifier: SessionNotifier | null = null;
	eventProcessor: SessionEventProcessor | null = null;
	subAgentRuntimeService: SubAgentRuntimeService | null = null;
	projectApplicationService: ProjectApplicationService | null = null;

	// ── Model (async) ──
	modelRuntime: ModelRuntime | null = null;
	modelRegistry: ModelRegistry | null = null;
	credentialStore: EncryptedCredentialStore | null = null;
	customProviders: CustomProvidersStore | null = null;

	// ── Extensions ──
	autoTitleService: AutoTitleService | null = null;
	runtimeFactory: SessionRuntimeFactory | null = null;
	/** Phase 1 RuntimePort seam — default PiAdapter; later engines plug in here. */
	runtimePort: RuntimePort | null = null;
	runtimePortRegistry: RuntimePortRegistry | null = null;
	/** Concrete default adapter (same instance as runtimePort when engine is pi). */
	piAdapter: PiAdapter | null = null;

	// ── Core (plan, agentDef, subagent, lifecycle — circular via closures) ──
	planService: PlanService | null = null;
	agentDefinitionService: AgentDefinitionService | null = null;
	sessionSubagentService: SessionSubagentService | null = null;
	runtimeLifecycle: RuntimeLifecycleCoordinator | null = null;

	// ── UI services ──
	sessionHistoryService: SessionHistoryService | null = null;
	sessionControlService: SessionControlService | null = null;
	sessionLifecycleService: SessionLifecycleService | null = null;
	projectDeletionService: ProjectDeletionService | null = null;
	sessionMessagingService: SessionMessagingService | null = null;
	sessionPermissionOrchestrator: SessionPermissionOrchestrator | null = null;
	sessionEventEffects: SessionEventEffects | null = null;
	sessionSettingsService: SessionSettingsService | null = null;
	skillManagementService: SkillManagementService | null = null;
	attachmentService: AttachmentService | null = null;

	// ── Mutable cross-cutting reference (shared with composition after build) ──
	readonly schedulerRef: { current: SchedulerService | null } = { current: null };

	/** @internal */
	host: CompositionHost | null = null;
	/** @internal */
	workspaceFileServiceRef: WorkspaceFileService | null = null;
	/** @internal */
	workspaceTreeServiceRef: WorkspaceTreeService | null = null;

	/**
	 * Validate and freeze into an immutable RuntimeManagerComposition.
	 *
	 * Checks that all required service fields are non-null. If any phase was
	 * skipped or failed, this throws a descriptive error identifying the
	 * missing field.
	 *
	 * Returns: this (for chaining with build() method)
	 */
	validate(): this {
		const required: Record<string, unknown> = {
			trustStore: this.trustStore,
			globalSettingsManager: this.globalSettingsManager,
			projectService: this.projectService,
			userSettings: this.userSettings,
			permissionService: this.permissionService,
			promptStore: this.promptStore,
			mcpManager: this.mcpManager,
			// computerUseService 仅在 darwin 构造（见构造处注释），按平台条件参与必填校验，
			// 否则非 macOS 会因合法的 null 直接启动失败。
			...(process.platform === "darwin" ? { computerUseService: this.computerUseService } : {}),
			browserService: this.browserService,
			sessionCatalog: this.sessionCatalog,
			projectRuntimeService: this.projectRuntimeService,
			sessionInfoService: this.sessionInfoService,
			sessionNotifier: this.sessionNotifier,
			eventProcessor: this.eventProcessor,
			subAgentRuntimeService: this.subAgentRuntimeService,
			projectApplicationService: this.projectApplicationService,
			modelRuntime: this.modelRuntime,
			modelRegistry: this.modelRegistry,
			credentialStore: this.credentialStore,
			customProviders: this.customProviders,
			autoTitleService: this.autoTitleService,
			runtimeFactory: this.runtimeFactory,
			runtimePort: this.runtimePort,
			runtimePortRegistry: this.runtimePortRegistry,
			planService: this.planService,
			agentDefinitionService: this.agentDefinitionService,
			sessionSubagentService: this.sessionSubagentService,
			runtimeLifecycle: this.runtimeLifecycle,
			sessionHistoryService: this.sessionHistoryService,
			sessionControlService: this.sessionControlService,
			sessionLifecycleService: this.sessionLifecycleService,
			projectDeletionService: this.projectDeletionService,
			sessionMessagingService: this.sessionMessagingService,
			sessionPermissionOrchestrator: this.sessionPermissionOrchestrator,
			sessionEventEffects: this.sessionEventEffects,
			sessionSettingsService: this.sessionSettingsService,
			skillManagementService: this.skillManagementService,
			attachmentService: this.attachmentService,
		};

		const missing = Object.entries(required)
			.filter(([, v]) => v === null)
			.map(([k]) => k);

		if (missing.length > 0) {
			throw new Error(`[Look] CompositionBuilder validation failed: missing services: ${missing.join(", ")}`);
		}

		return this;
	}

	/** Accessors for RuntimeManagerComposition constructor. */
	getWorkspaceFileService(): WorkspaceFileService | null {
		return this.workspaceFileServiceRef;
	}
	getWorkspaceTreeService(): WorkspaceTreeService | null {
		return this.workspaceTreeServiceRef;
	}

	// ── Helpers (shared across phases) ──

	/**
	 * 草稿行预期默认值（延迟执行，modelRegistry 在 Phase 2 就位）。
	 * 解析序与 pi findInitialModel 对齐，见 expected-session-defaults.ts。
	 */
	/** @internal */
	resolveExpectedSessionDefaults(projectId?: string): ExpectedSessionDefaults {
		const projectSettings = projectId ? this.createProjectSettingsManager(projectId) : undefined;
		return resolveExpectedSessionDefaults({
			globalSettingsManager: this.req(this.globalSettingsManager, "globalSettingsManager"),
			modelRegistry: this.req(this.modelRegistry, "modelRegistry"),
			getDefaultSettings: projectSettings
				? () => ({
						defaultProvider: projectSettings.getDefaultProvider(),
						defaultModel: projectSettings.getDefaultModel(),
						defaultThinkingLevel: projectSettings.getDefaultThinkingLevel(),
					})
				: undefined,
			getAvailableModels: () => getAvailableModels(this.req(this.modelRegistry, "modelRegistry")),
		});
	}

	/** Read the same trusted project settings that SessionRuntimeFactory uses. */
	/** @internal */
	createProjectSettingsManager(projectId: string): SettingsManager | undefined {
		const project = this.projectService?.getProjectInfo(projectId);
		if (!project) return undefined;
		const settings = SettingsManager.create(project.cwd, getLookDir());
		settings.setProjectTrusted(this.req(this.projectService, "projectService").resolveProjectTrust(project.cwd));
		return settings;
	}

	/**
	 * 挂起意图 → 草稿/持久化行投影覆盖。模型切换覆盖模型字段并按新模型
	 * 重算思考档位表（默认档与 SDK 显式 model 路径一致：medium 就近收敛）；
	 * 思考切换覆盖档位（有挂起模型时按其档位表钳制，否则物化时由 SDK 钳制）。
	 */
	/** @internal */
	resolvePendingIntentOverrides(sessionId: string): Partial<ExpectedSessionDefaults> | undefined {
		const modelKey = this.sessionPendingIntents.peekModel(sessionId);
		const pendingThinking = this.sessionPendingIntents.peekThinkingLevel(sessionId);
		if (modelKey === undefined && pendingThinking === undefined) return undefined;
		const overrides: Partial<ExpectedSessionDefaults> = {};
		let levels: ThinkingLevel[] | undefined;
		if (modelKey !== undefined) {
			const slash = modelKey.indexOf("/");
			const model =
				slash > 0 ? this.modelRegistry?.find(modelKey.slice(0, slash), modelKey.slice(slash + 1)) : undefined;
			if (model) {
				overrides.model = modelKey;
				overrides.modelSupportsThinking = !!model.reasoning;
				levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
				overrides.availableThinkingLevels = levels;
				overrides.thinkingLevel = clampThinkingLevel(model, "medium") as ThinkingLevel;
			}
		}
		if (pendingThinking !== undefined) {
			overrides.thinkingLevel =
				levels && !levels.includes(pendingThinking)
					? (overrides.thinkingLevel ?? pendingThinking)
					: pendingThinking;
		}
		return overrides;
	}

	/** 会话存在性（live runtime 之外）：catalog stored / 草稿索引 / 在途初始化。 */
	/** @internal */
	sessionExists(sessionId: string): boolean {
		return (
			this.req(this.sessionCatalog, "sessionCatalog").get(sessionId) !== undefined ||
			this.draftIndex.get(sessionId) !== undefined ||
			this.runtimeLifecycle?.hasPendingCreation(sessionId) === true
		);
	}

	/** @internal */
	findProjectIdByCwd(cwd: string): string | undefined {
		return this.req(this.projectService, "projectService")
			.listProjects()
			.find((project) => project.cwd === cwd)?.id;
	}

	/** @internal */
	refreshProjectSessions(projectId: string) {
		const project = this.req(this.projectService, "projectService").getProjectInfo(projectId);
		return project?.valid ? this.req(this.sessionCatalog, "sessionCatalog").refresh(project) : Promise.resolve([]);
	}

	/** @internal */
	sessionManagerFor(sessionId: string): SessionManager | undefined {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.binding.sessionManager;
		const stored = this.req(this.sessionCatalog, "sessionCatalog").get(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : undefined;
	}
}
