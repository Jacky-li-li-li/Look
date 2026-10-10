// CompositionBuilder phase
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureLookDir, getLookDir, getUiSettingsPath, resetLegacySessionsOnce } from "@look/shared/look-storage";
import { BrowserService } from "../../../browser/browser-service.js";
import { ComputerUseService } from "../../../computer-use/computer-use-service.js";
import { MCPManager } from "../../../mcp/manager.js";
import { PermissionService } from "../../../permissions/service.js";
import { ProjectService } from "../../../projects/project-service.js";
import { SubAgentRuntimeService } from "../../../services/subagent-runtime.js";
import { migrateLegacySettings } from "../../../settings/migrate.js";
import { PromptStore } from "../../../settings/prompt-store.js";
import { UserSettingsStore } from "../../../settings/store.js";
import { getTranscriptionService } from "../../../transcribe/transcription-service.js";
import type { WorkspaceFileService } from "../../../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../../../workspace/workspace-tree-service.js";
import { MAX_NAME_LENGTH } from "../../constants.js";
import { SessionEventProcessor } from "../../events/session-event-processor.js";
import { SessionNotifier } from "../../events/session-notifier.js";
import { ProjectApplicationService } from "../../services/project-application-service.js";
import { ProjectRuntimeService } from "../../services/project-runtime-service.js";
import { SessionCatalog } from "../../services/session-catalog.js";
import { SessionInfoService } from "../../services/session-info-service.js";
import type { CompositionBuilder } from "../builder.js";
import { CompositionHost } from "../composition-host.js";

export function buildInfraPhase(
	b: CompositionBuilder,
	workspaceFileService: WorkspaceFileService | null,
	workspaceTreeService: WorkspaceTreeService | null,
): void {
	b.workspaceFileServiceRef = workspaceFileService;
	b.workspaceTreeServiceRef = workspaceTreeService;

	ensureLookDir();
	resetLegacySessionsOnce();
	const migration = migrateLegacySettings();
	if (migration.migrated && migration.keys.length > 0) {
		console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
	}

	b.trustStore = new ProjectTrustStore(getLookDir());
	b.globalSettingsManager = SettingsManager.create(getLookDir(), getLookDir());
	b.projectService = new ProjectService(b.trustStore, b.globalSettingsManager);
	b.userSettings = new UserSettingsStore(b.globalSettingsManager, getUiSettingsPath());
	// NOTE: userSettings MUST be created before permissionService — the
	// PermissionService constructor reads userSettings.getAll().permissionMode.
	// If these lines are reordered, PermissionService will crash on a null ref.
	b.permissionService = new PermissionService(b.eventBus, b.userSettings.getAll().permissionMode);
	// Default to "ask" only when the user has not chosen a policy;
	// setDefaultProjectTrust persists, so an unconditional call would reset
	// an explicitly configured "always"/"never" on every launch.
	if (b.globalSettingsManager.getGlobalSettings().defaultProjectTrust === undefined) {
		b.globalSettingsManager.setDefaultProjectTrust("ask");
	}
	b.promptStore = new PromptStore();

	b.mcpManager = new MCPManager();
	// 空闲连接回收（Proma 式连接池）：5 分钟未调用的 MCP 连接断开并释放
	// stdio 子进程；定时器 unref，不阻止应用退出。
	b.mcpManager.startIdleReaper();

	// 转写服务：进程级单例（模型加载很重，所有会话共享一个驻留模型 + 串行队列）。
	b.transcribeService = getTranscriptionService();

	// Computer Use 是进程级 OS 服务（截图/输入与具体会话无关），
	// 与 MCPManager 同为全局共享服务；构造不触碰 Electron API，
	// 真正的 desktopCapturer/nut-js 调用发生在工具执行时（app ready 后）。
	// v1 仅支持 macOS：服务依赖 macOS 专属 TCC API
	// （getMediaAccessStatus("screen") / isTrustedAccessibilityClient），
	// 且输入坐标按主屏全局原点设计；非 macOS 不构造服务、不注册
	// computer_* 工具，避免暴露必然失败的入口。
	b.computerUseService = process.platform === "darwin" ? new ComputerUseService() : null;
	b.browserService = new BrowserService();

	b.sessionCatalog = new SessionCatalog((metadata) => {
		// Captures CompositionBuilder's subAgentRegistry field (assigned above).
		// `this` refers to the builder, not the SessionCatalog instance.
		if (metadata.parentSessionId) {
			b.subAgentRegistry.register(metadata.parentSessionId, metadata.sessionId, metadata.agentName ?? "");
		}
	});
	b.host = new CompositionHost(
		b.eventBus,
		b.runtimeRegistry,
		b.sessionCatalog,
		b.projectService,
		b.activeSessionSelection,
	);
	const host = b.host;
	b.mcpManager.setOnChange(() => host.emit({ type: "mcp:status-changed" }));
	// 项目激活即后台预热 MCP（应用启动/切项目/跨项目切会话都会经过
	// setActiveId）：把冷启动挪到用户还在浏览界面的空闲窗口，首个
	// 新建会话直接命中已连接客户端。信任门与 mcp-extension 的
	// session_start 一致——项目级 .look/mcp.json 仅受信任时加载。
	b.projectService.setOnActiveProjectChanged((projectId) => {
		if (!projectId) return;
		const project = b.req(b.projectService, "projectService").getProjectInfo(projectId);
		if (!project?.valid) return;
		const loadProjectConfig = b.req(b.projectService, "projectService").resolveProjectTrust(project.cwd);
		void b.req(b.mcpManager, "mcpManager").prewarmProject(projectId, project.cwd, { loadProjectConfig });
	});
	// 信任授予 → 强制重踢预热，补载项目级 .look/mcp.json（信任前的预热
	// 出于安全门跳过了它）。挂在 projectRuntimeService 总闸，覆盖启动
	// 弹窗与 IPC 两条信任落地路径。
	b.projectRuntimeService = new ProjectRuntimeService({
		projectService: b.projectService,
		sessionCatalog: b.sessionCatalog,
		runtimeRegistry: b.runtimeRegistry,
	});
	b.projectRuntimeService.setOnProjectTrusted((projectId, cwd) => {
		void b.req(b.mcpManager, "mcpManager").prewarmProject(projectId, cwd, {
			loadProjectConfig: true,
			force: true,
		});
	});
	b.sessionInfoService = new SessionInfoService({
		runtimeRegistry: b.runtimeRegistry,
		sessionCatalog: b.sessionCatalog,
		draftIndex: b.draftIndex,
		subAgentRegistry: b.subAgentRegistry,
		scopeRegistry: b.scopeRegistry,
		maxNameLength: MAX_NAME_LENGTH,
		listProjects: () => host.listProjects(),
		// 草稿行预期默认值（延迟执行，modelRegistry 在 Phase 2 就位）。
		getExpectedSessionDefaults: (projectId) => b.resolveExpectedSessionDefaults(projectId),
		// 挂起意图覆盖：runtime 未就绪时用户已切换的模型/思考立即上屏。
		getPendingIntentOverrides: (sessionId) => b.resolvePendingIntentOverrides(sessionId),
	});
	b.sessionNotifier = new SessionNotifier(b.eventBus, {
		sessionInfoService: b.sessionInfoService,
		scopeRegistry: b.scopeRegistry,
		listProjects: () => host.listProjects(),
		getActiveProjectId: () => b.req(b.projectService, "projectService").activeId,
	});

	b.eventProcessor = new SessionEventProcessor(host, b.scopeRegistry, host);
	b.subAgentRuntimeService = new SubAgentRuntimeService(host, b.subAgentRegistry);

	b.projectApplicationService = new ProjectApplicationService({
		projectService: b.projectService,
		projectRuntimeService: b.projectRuntimeService,
		sessionCatalog: b.sessionCatalog,
		runtimeRegistry: b.runtimeRegistry,
		sessionNotifier: b.sessionNotifier,
		eventBus: b.eventBus,
	});
}
