import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	hasProjectTrustInputs,
	ModelRegistry,
	type SessionInfo as PiSessionInfo,
	ProjectTrustStore,
	SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { v4 as uuidv4 } from "uuid";
import {
	createPermissionExtensionFactory,
	createPlanModeHandler,
	type ToolCallHandler,
} from "./extensions/permission-extension.js";
import {
	createPlanExtensionFactory,
	PLAN_TOOL_NAMES,
	type PlanApprovalOutcome,
	type PlanQuestionOutcome,
} from "./extensions/plan-extension.js";
import { createMcpExtensionFactory } from "./mcp/mcp-extension.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { migrateLegacySettings } from "./migrate-settings.js";
import {
	ensureLookDir,
	ensureWorkspaceDir,
	getAuthPath,
	getLookDir,
	getModelsPath,
	getProjectSharedDir,
	getProjectsIndexPath,
	getUiSettingsPath,
	resetLegacySessionsOnce,
} from "./shared/look-storage.js";
import type {
	AgentInfo,
	ForkedSessionResult,
	MainToRendererEvent,
	NavigateTreeResult,
	PermissionAskEvent,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalRequest,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionRequest,
	PlanQuestionResponse,
	ProjectInfo,
	SessionSnapshotEnvelope,
	ThinkingLevel,
} from "./shared/types.js";
import { type UserSettings, UserSettingsStore } from "./user-settings.js";
import type { WorkspaceFileService } from "./workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "./workspace/workspace-tree-service.js";

export type EventCallback = (event: MainToRendererEvent) => void;

interface StoredSession extends PiSessionInfo {
	projectId: string;
}

interface ManagedRuntime {
	readonly runtime: AgentSessionRuntime;
	readonly projectId: string;
	readonly createdAt: number;
	unsubscribe: () => void;
}

const MAX_NAME_LENGTH = 80;
const PERMISSION_MODE_ENTRY_TYPE = "look.permission-mode.v1";
const PLAN_STATE_ENTRY_TYPE = "look.plan-state.v1";
const PLAN_RECORD_ENTRY_TYPE = "look.plan.v1";
const PERMISSION_TIMEOUT_MS = 30_000;

interface PendingPermission {
	sessionId: string;
	resolve: (action: "allow" | "deny" | "allow_always") => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface PendingPlanQuestion {
	request: PlanQuestionRequest;
	resolve: (outcome: PlanQuestionOutcome) => void;
	removeAbortListener: () => void;
}

interface PendingPlanApproval {
	request: PlanApprovalRequest;
	resolve: (outcome: PlanApprovalOutcome) => void;
	removeAbortListener: () => void;
	resolving: boolean;
}

function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "always" || value === "ask" || value === "plan";
}

/**
 * Hosts independent pi AgentSessionRuntime instances for sessions that are
 * selected or currently running. Each runtime still owns exactly one active pi
 * session; Look only supplies the cross-session registry and event routing.
 */
export class SessionRuntimeManager {
	private readonly projects = new Map<string, ProjectInfo>();
	private readonly sessionsByProject = new Map<string, StoredSession[]>();
	private readonly eventCallbacks: EventCallback[] = [];
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly trustStore: ProjectTrustStore;
	private readonly globalSettingsManager: SettingsManager;
	private readonly userSettings: UserSettingsStore;
	private readonly projectsIndexPath: string;
	private readonly runtimes = new Map<string, ManagedRuntime>();
	private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>();
	private readonly forkOperationTails = new Map<string, Promise<void>>();
	private resourceInitializationTail: Promise<void> = Promise.resolve();
	private activeProjectId: string | null = null;
	private activeSessionId: string | null = null;
	private _mcpManager: McpManager | null = null;
	private defaultPermissionMode: PermissionMode = "ask";
	private readonly permissionModesBySession = new Map<string, PermissionMode>();
	private readonly dirtyPermissionModes = new Set<string>();
	private readonly workspaceFileService: WorkspaceFileService | null;
	private readonly workspaceTreeService: WorkspaceTreeService | null;
	private disposed = false;
	/** Permission ask mode: pending requests keyed by requestId. */
	private readonly permissionAwaiting = new Map<string, PendingPermission>();
	/** "ask" mode: tool grants keyed by pi session ID. */
	private readonly sessionAllowedTools = new Map<string, Set<string>>();
	/** Active Plan interaction keyed by request ID; one interaction per session. */
	private readonly planQuestionsAwaiting = new Map<string, PendingPlanQuestion>();
	private readonly planApprovalsAwaiting = new Map<string, PendingPlanApproval>();
	private readonly planInteractionBySession = new Map<string, { kind: "question" | "approval"; requestId: string }>();
	/** Exact active tool list captured immediately before entering Plan. */
	private readonly prePlanToolsBySession = new Map<string, string[]>();
	private readonly dirtyPlanToolSnapshots = new Set<string>();
	/** Per-runtime streaming state machine. The SDK's `session.isStreaming` getter
	 *  can lag behind events, so we derive a canonical UI state from the event stream:
	 *  - idle: no turn in progress
	 *  - streaming: a turn is actively producing output
	 *  - retrying: the last turn ended but requested a retry (still "running" visually)
	 *  All renderer-facing reports use this canonical state instead of the raw getter. */
	private readonly streamingStates = new Map<string, "idle" | "streaming" | "retrying">();

	/** Whether the session should be reported as streaming to the renderer.
	 *  Falls back to the SDK getter only when no event-derived state exists. */
	private isStreaming(sessionId: string, sdkValue: boolean): boolean {
		const state = this.streamingStates.get(sessionId);
		if (state === "idle") return false;
		if (state === "streaming" || state === "retrying") return true;
		return sdkValue;
	}

	constructor(workspaceFileService?: WorkspaceFileService, workspaceTreeService?: WorkspaceTreeService) {
		ensureLookDir();
		resetLegacySessionsOnce();
		const migration = migrateLegacySettings();
		if (migration.migrated && migration.keys.length > 0) {
			console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
		}
		this.authStorage = AuthStorage.create(getAuthPath());
		this.modelRegistry = ModelRegistry.create(this.authStorage, getModelsPath());
		this.trustStore = new ProjectTrustStore(getLookDir());
		this.globalSettingsManager = SettingsManager.create(getLookDir(), getLookDir());
		this.userSettings = new UserSettingsStore(this.globalSettingsManager, getUiSettingsPath());
		this.defaultPermissionMode = this.userSettings.getAll().permissionMode;
		// Tool authorization must never silently grant trust to project resources.
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		this.projectsIndexPath = getProjectsIndexPath();
		this.workspaceFileService = workspaceFileService ?? null;
		this.workspaceTreeService = workspaceTreeService ?? null;
	}

	getWorkspaceFileService(): WorkspaceFileService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.workspaceFileService) {
			throw new Error("WorkspaceFileService is not configured for this SessionRuntimeManager");
		}
		return this.workspaceFileService;
	}

	getWorkspaceTreeService(): WorkspaceTreeService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.workspaceTreeService) {
			throw new Error("WorkspaceTreeService is not configured for this SessionRuntimeManager");
		}
		return this.workspaceTreeService;
	}

	/** O(1) lookup by id. */
	getProjectInfo(projectId: string): ProjectInfo | null {
		return this.projects.get(projectId) ?? null;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.workspaceFileService) {
			try {
				await this.workspaceFileService.dispose();
			} catch (error) {
				console.error("[Look] workspaceFileService dispose failed:", error);
			}
		}
		if (this.workspaceTreeService) {
			try {
				await this.workspaceTreeService.dispose();
			} catch (error) {
				console.error("[Look] workspaceTreeService dispose failed:", error);
			}
		}
		await this.disposeAllRuntimes();
	}

	getMcpManager(): McpManager {
		this._mcpManager ??= new McpManager();
		return this._mcpManager;
	}

	async loadProjects(): Promise<ProjectInfo[]> {
		try {
			if (existsSync(this.projectsIndexPath)) {
				const raw = JSON.parse(fs.readFileSync(this.projectsIndexPath, "utf8"));
				const seenCwds = new Set<string>();
				for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
					const valid = existsSync(item.cwd) && fs.statSync(item.cwd).isDirectory();
					const info: ProjectInfo = { ...item, cwd: valid ? fs.realpathSync(item.cwd) : item.cwd, valid };
					if (seenCwds.has(info.cwd)) continue;
					seenCwds.add(info.cwd);
					this.projects.set(info.id, info);
				}
				this.saveProjects();
			}
		} catch (error) {
			console.error("[Look] Failed to load projects:", error);
		}
		return this.listProjects();
	}

	async restoreWorkspace(): Promise<number> {
		let total = 0;
		for (const project of this.projects.values()) {
			if (!project.valid) continue;
			total += (await this.refreshProjectSessions(project.id)).length;
		}

		const settings = this.userSettings.getAll();
		const preferredProject = this.projects.get(settings.lastActiveProjectId);
		const project = preferredProject?.valid ? preferredProject : this.listProjects().find((p) => p.valid);
		if (!project) return total;

		this.activeProjectId = project.id;
		const sessions = this.sessionsByProject.get(project.id) ?? [];
		const preferred = sessions.find((s) => s.id === settings.lastActiveSessionId) ?? sessions[0];
		if (preferred) await this.activateSession(preferred.id);
		return total;
	}

	private saveProjects(): void {
		const projects = Array.from(this.projects.values()).map(({ valid: _valid, ...project }) => project);
		const tmp = `${this.projectsIndexPath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2));
		fs.renameSync(tmp, this.projectsIndexPath);
	}

	listProjects(): ProjectInfo[] {
		return Array.from(this.projects.values()).sort((a, b) => {
			if (a.valid !== b.valid) return a.valid ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	getActiveProject(): ProjectInfo | null {
		return this.activeProjectId ? (this.projects.get(this.activeProjectId) ?? null) : null;
	}

	getActiveProjectCwd(): string {
		const project = this.getActiveProject();
		if (!project) throw new Error("No active project. Select a project folder first.");
		if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		return project.cwd;
	}

	getProjectRoot(): string {
		return this.getActiveProjectCwd();
	}

	getProjectTrustStatus(projectId: string): {
		requiresTrust: boolean;
		decision: boolean | null;
		shouldAsk: boolean;
	} {
		const project = this.projects.get(projectId);
		if (!project?.valid || !hasProjectTrustInputs(project.cwd)) {
			return { requiresTrust: false, decision: true, shouldAsk: false };
		}
		const decision = this.trustStore.get(project.cwd);
		return {
			requiresTrust: true,
			decision,
			shouldAsk: decision === null && this.globalSettingsManager.getDefaultProjectTrust() === "ask",
		};
	}

	async setProjectTrust(projectId: string, trusted: boolean): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project?.valid) throw new Error(`Project ${projectId} not found`);
		this.trustStore.set(project.cwd, trusted);
		await Promise.all(
			Array.from(this.runtimes.values())
				.filter((managed) => managed.runtime.cwd === project.cwd)
				.map(async (managed) => {
					managed.runtime.services.settingsManager.setProjectTrusted(trusted);
					await managed.runtime.session.reload();
				}),
		);
	}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		if (!existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new Error(`Project path is not a directory: ${cwd}`);
		}
		const canonicalCwd = fs.realpathSync(cwd);
		const existing = Array.from(this.projects.values()).find((project) => project.cwd === canonicalCwd);
		if (existing) {
			await this.setActiveProject(existing.id);
			return { project: existing, isDuplicate: true };
		}

		let finalName = name?.trim() || path.basename(canonicalCwd);
		const names = new Set(Array.from(this.projects.values()).map((project) => project.name));
		for (let suffix = 2; names.has(finalName); suffix++)
			finalName = `${name || path.basename(canonicalCwd)} (${suffix})`;
		const project: ProjectInfo = {
			id: uuidv4().slice(0, 8),
			name: finalName,
			cwd: canonicalCwd,
			createdAt: Date.now(),
			valid: true,
		};
		this.projects.set(project.id, project);
		this.sessionsByProject.set(project.id, []);
		this.saveProjects();
		await this.setActiveProject(project.id);
		return { project, isDuplicate: false };
	}

	async setActiveProject(projectId: string): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project) throw new Error(`Project ${projectId} not found`);
		this.activeProjectId = projectId;
		if (project.valid) await this.refreshProjectSessions(projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId });
		this.emitSessionList(projectId);
	}

	async deleteProject(projectId: string): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project) return;
		const persisted = this.sessionsByProject.get(projectId) ?? [];
		const runtimeIds = Array.from(this.runtimes.entries())
			.filter(([, managed]) => managed.projectId === projectId)
			.map(([sessionId]) => sessionId);
		this.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: project.name,
			agentCount: new Set([...persisted.map((session) => session.id), ...runtimeIds]).size,
			runningCount: runtimeIds.filter((sessionId) => {
				const session = this.runtimes.get(sessionId)?.runtime.session;
				return Boolean(session && (session.isStreaming || session.isRetrying || session.isCompacting));
			}).length,
		});
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		const sessions = this.sessionsByProject.get(projectId) ?? [];
		const runtimeIds = Array.from(this.runtimes.entries())
			.filter(([, managed]) => managed.projectId === projectId)
			.map(([sessionId]) => sessionId);
		await Promise.all(runtimeIds.map((sessionId) => this.disposeRuntime(sessionId, true)));
		// 先停 watcher,再删目录,避免 chokidar 监听已删 inode 持续报错
		if (this.workspaceFileService) {
			try {
				await this.workspaceFileService.stopWatching(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop shared area watcher for ${projectId}:`, error);
			}
		}
		if (this.workspaceTreeService) {
			try {
				await this.workspaceTreeService.stopAllWatchesForProject(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop workspace tree watchers for ${projectId}:`, error);
			}
		}
		for (const session of sessions) {
			try {
				fs.unlinkSync(session.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		this.sessionsByProject.delete(projectId);
		this.projects.delete(projectId);
		// 删除项目时清理共享区
		const sharedDir = getProjectSharedDir(projectId);
		if (existsSync(sharedDir)) {
			try {
				fs.rmSync(sharedDir, { recursive: true, force: true });
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					console.error(`Failed to remove shared area for project ${projectId}:`, error);
				}
			}
		}
		if (this.activeSessionId && runtimeIds.includes(this.activeSessionId)) this.activeSessionId = null;
		if (this.activeProjectId === projectId) {
			this.activeProjectId = this.listProjects().find((project) => project.valid)?.id ?? null;
		}
		this.saveProjects();
		this.emitSessionList(projectId);
		this.emitProjectList();
		if (this.activeProjectId) this.emitSessionList(this.activeProjectId);
	}

	renameProject(projectId: string, name: string): void {
		const project = this.projects.get(projectId);
		const trimmed = name.trim();
		if (!project || !trimmed) return;
		project.name = trimmed;
		this.saveProjects();
		this.emitProjectList();
	}

	private async refreshProjectSessions(projectId: string): Promise<StoredSession[]> {
		const project = this.projects.get(projectId);
		if (!project?.valid) return [];
		const sessions = (await SessionManager.list(project.cwd, ensureWorkspaceDir(project.name))).map((session) => ({
			...session,
			projectId,
		}));
		this.sessionsByProject.set(projectId, sessions);
		return sessions;
	}

	private findStoredSession(sessionId: string): StoredSession | undefined {
		for (const sessions of this.sessionsByProject.values()) {
			const found = sessions.find((session) => session.id === sessionId);
			if (found) return found;
		}
		return undefined;
	}

	private sessionInfo(session: StoredSession): AgentInfo {
		const managed = this.runtimes.get(session.id);
		const piSession = managed?.runtime.session;
		const stats = piSession?.getSessionStats();
		const model = piSession?.model;
		return {
			id: session.id,
			name: (session.name || session.firstMessage || "New chat").slice(0, MAX_NAME_LENGTH),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: (piSession?.thinkingLevel as ThinkingLevel | undefined) ?? "off",
			modelSupportsThinking: piSession?.supportsThinking() ?? false,
			availableThinkingLevels: (piSession?.getAvailableThinkingLevels() as ThinkingLevel[] | undefined) ?? ["off"],
			isStreaming: piSession?.isStreaming ?? false,
			isRetrying: piSession?.isRetrying ?? false,
			isCompacting: piSession?.isCompacting ?? false,
			messageCount: stats?.totalMessages ?? session.messageCount,
			createdAt: session.created.getTime(),
			sessionFilePath: session.path,
			projectId: session.projectId,
		};
	}

	private runtimeInfo(sessionId: string, managed: ManagedRuntime): AgentInfo {
		const session = managed.runtime.session;
		const stats = session.getSessionStats();
		const model = session.model;
		return {
			id: sessionId,
			name: (session.sessionManager.getSessionName() || "New chat").slice(0, MAX_NAME_LENGTH),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			modelSupportsThinking: session.supportsThinking(),
			availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
			isStreaming: this.isStreaming(sessionId, session.isStreaming),
			isRetrying: session.isRetrying,
			isCompacting: session.isCompacting,
			messageCount: stats.totalMessages,
			createdAt: managed.createdAt,
			sessionFilePath: session.sessionFile && existsSync(session.sessionFile) ? session.sessionFile : undefined,
			projectId: managed.projectId,
		};
	}

	listAgents(): AgentInfo[] {
		return this.listProjects().flatMap((project) => this.listAgentsInProject(project.id));
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		const persisted = (this.sessionsByProject.get(projectId) ?? []).map((session) => this.sessionInfo(session));
		const persistedIds = new Set(persisted.map((session) => session.id));
		const drafts = Array.from(this.runtimes.entries())
			.filter(([sessionId, managed]) => managed.projectId === projectId && !persistedIds.has(sessionId))
			.map(([sessionId, managed]) => this.runtimeInfo(sessionId, managed));
		return [...drafts, ...persisted];
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		const managed = this.runtimes.get(sessionId);
		if (managed) return this.runtimeInfo(sessionId, managed);
		const session = this.findStoredSession(sessionId);
		return session ? this.sessionInfo(session) : undefined;
	}

	private findProjectIdByCwd(cwd: string): string | undefined {
		for (const project of this.projects.values()) {
			if (project.cwd === cwd) return project.id;
		}
		return undefined;
	}

	private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			await this.getMcpManager().connectAll();
			return this.withResourceInitialization(async () => {
				const settingsManager = SettingsManager.create(cwd, getLookDir());
				const trusted = this.resolveProjectTrust(cwd);
				settingsManager.setProjectTrusted(trusted);
				const projectId = this.findProjectIdByCwd(cwd);
				const sharedPath = projectId ? getProjectSharedDir(projectId) : undefined;
				const appendPrompt = sharedPath
					? `\n## 共享区（Shared Area）\n项目共享文件目录：${sharedPath}\n你可以通过 read、write、edit、ls 等工具访问此目录。这些文件在同一项目的所有会话中共享，新建或打开历史会话均可读取。\n`
					: undefined;
				const services = await createAgentSessionServices({
					cwd,
					agentDir: getLookDir(),
					authStorage: this.authStorage,
					modelRegistry: this.modelRegistry,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: this.buildExtensionFactories(cwd, sessionManager.getSessionId()),
						appendSystemPrompt: appendPrompt ? [appendPrompt] : undefined,
					},
					resourceLoaderReloadOptions: {
						resolveProjectTrust: async () => trusted,
					},
				});
				const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
				return { ...result, services, diagnostics: services.diagnostics };
			});
		};
	}

	private async withResourceInitialization<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.resourceInitializationTail;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.resourceInitializationTail = tail;
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.resourceInitializationTail === tail) this.resourceInitializationTail = Promise.resolve();
		}
	}

	private buildExtensionFactories(cwd: string, sessionId: string): ExtensionFactory[] {
		// Always register the permission extension — it checks
		// this._permissionMode at runtime so mode switches are
		// instantaneous and never require a runtime rebuild.
		const handler = this.createPermissionToolCallHandler(cwd);
		return [
			createPermissionExtensionFactory(handler),
			createPlanExtensionFactory(sessionId, {
				getMode: (id) => this.permissionModesBySession.get(id) ?? this.defaultPermissionMode,
				askQuestions: (id, questions, signal) => this.requestPlanQuestions(id, questions, signal),
				submitPlan: (id, plan, signal) => this.requestPlanApproval(id, plan, signal),
			}),
			createMcpExtensionFactory(this.getMcpManager()),
		];
	}

	private resolveProjectTrust(cwd: string): boolean {
		if (!hasProjectTrustInputs(cwd)) return true;
		const saved = this.trustStore.get(cwd);
		if (saved !== null) return saved;
		return this.globalSettingsManager.getDefaultProjectTrust() === "always";
	}

	private async createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt = Date.now(),
		sessionStartEvent?: SessionStartEvent,
	): Promise<ManagedRuntime> {
		const runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
			cwd,
			agentDir: getLookDir(),
			sessionManager,
			sessionStartEvent,
		});
		return this.bindRuntime(runtime, projectId, createdAt);
	}

	private async bindRuntime(
		runtime: AgentSessionRuntime,
		projectId: string,
		createdAt: number,
	): Promise<ManagedRuntime> {
		const session = runtime.session;
		this.restorePermissionMode(session.sessionId, session.sessionManager);
		this.restorePlanToolSnapshot(session.sessionId, session.sessionManager);
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		const managed: ManagedRuntime = {
			runtime,
			projectId,
			createdAt,
			unsubscribe: () => {},
		};
		// Initialize canonical streaming state from the SDK snapshot at bind time.
		// Subsequent transitions are driven by agent_start / agent_end events.
		this.streamingStates.set(session.sessionId, session.isStreaming ? "streaming" : "idle");
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		runtime.setRebindSession(async (nextSession) => this.rebindRuntime(runtime, nextSession));
		this.runtimes.set(session.sessionId, managed);
		this.syncPlanToolState(session.sessionId);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
		return managed;
	}

	private async rebindRuntime(runtime: AgentSessionRuntime, session: AgentSession): Promise<void> {
		const previousEntry = Array.from(this.runtimes.entries()).find(([, managed]) => managed.runtime === runtime);
		if (!previousEntry) throw new Error("Runtime replacement lost its registry entry");
		const [previousSessionId, managed] = previousEntry;
		managed.unsubscribe();
		this.cancelPendingPermissions(previousSessionId);
		this.cancelPlanInteractions(previousSessionId, "Runtime was replaced");
		this.permissionModesBySession.delete(previousSessionId);
		this.dirtyPermissionModes.delete(previousSessionId);
		this.sessionAllowedTools.delete(previousSessionId);
		this.prePlanToolsBySession.delete(previousSessionId);
		this.dirtyPlanToolSnapshots.delete(previousSessionId);
		this.restorePermissionMode(session.sessionId, session.sessionManager);
		this.restorePlanToolSnapshot(session.sessionId, session.sessionManager);
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		this.runtimes.delete(previousSessionId);
		this.streamingStates.delete(previousSessionId);
		this.streamingStates.set(session.sessionId, session.isStreaming ? "streaming" : "idle");
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		this.runtimes.set(session.sessionId, managed);
		this.syncPlanToolState(session.sessionId);
		if (this.activeSessionId === previousSessionId) this.activeSessionId = session.sessionId;
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
	}

	private emitRuntimeDiagnostics(sessionId: string, runtime: AgentSessionRuntime): void {
		for (const diagnostic of runtime.diagnostics) {
			if (diagnostic.type === "error" || diagnostic.type === "warning") {
				this.emit({ type: "error", agentId: sessionId, message: diagnostic.message });
			}
		}
		if (runtime.modelFallbackMessage) {
			this.emit({
				type: "error",
				agentId: sessionId,
				message: runtime.modelFallbackMessage,
			});
		}
	}

	private async ensureRuntime(sessionId: string): Promise<ManagedRuntime> {
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		const pending = this.runtimeInitializations.get(sessionId);
		if (pending) return pending;
		const stored = this.findStoredSession(sessionId);
		if (!stored) throw new Error(`Session ${sessionId} not found`);
		const initialization = this.createManagedRuntime(
			stored.cwd,
			SessionManager.open(stored.path),
			stored.projectId,
			stored.created.getTime(),
		).finally(() => this.runtimeInitializations.delete(sessionId));
		this.runtimeInitializations.set(sessionId, initialization);
		return initialization;
	}

	private async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		const pending = this.runtimeInitializations.get(sessionId);
		if (pending) await pending.catch(() => undefined);
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		this.cancelPendingPermissions(sessionId);
		this.cancelPlanInteractions(sessionId, "Session runtime was disposed");
		if (abort && managed.runtime.session.isStreaming) await managed.runtime.session.abort();
		this.persistPermissionModeIfPossible(sessionId);
		this.persistPlanToolSnapshotIfPossible(sessionId);
		managed.unsubscribe();
		this.runtimes.delete(sessionId);
		this.permissionModesBySession.delete(sessionId);
		this.dirtyPermissionModes.delete(sessionId);
		this.sessionAllowedTools.delete(sessionId);
		this.prePlanToolsBySession.delete(sessionId);
		this.dirtyPlanToolSnapshots.delete(sessionId);
		this.streamingStates.delete(sessionId);
		await managed.runtime.dispose();
	}

	async disposeAllRuntimes(): Promise<void> {
		await Promise.all(Array.from(this.runtimes.keys()).map((sessionId) => this.disposeRuntime(sessionId, true)));
	}

	async activateSession(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.runtimes.has(sessionId)) {
			this.emitSessionState(sessionId, "activate");
			return;
		}
		const managed = await this.ensureRuntime(sessionId);
		this.activeProjectId = managed.projectId;
		this.activeSessionId = sessionId;
		await this.refreshProjectSessions(managed.projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId: managed.projectId });
		this.emitSessionState(sessionId);
	}

	async createAgent(opts?: { name?: string; projectId?: string } | string): Promise<string> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.activeProjectId;
		if (!projectId) throw new Error("No active project");
		const project = this.projects.get(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		const managed = await this.createManagedRuntime(
			project.cwd,
			SessionManager.create(project.cwd, ensureWorkspaceDir(project.name)),
			projectId,
		);
		const session = managed.runtime.session;
		session.setSessionName((input.name?.trim() || "New chat").slice(0, MAX_NAME_LENGTH));
		this.activeProjectId = projectId;
		this.activeSessionId = session.sessionId;
		await this.refreshProjectSessions(projectId);
		this.emit({
			type: "agent:created",
			agentId: session.sessionId,
			agent: this.runtimeInfo(session.sessionId, managed),
		});
		this.emitSessionState(session.sessionId, "initial");
		return session.sessionId;
	}

	async destroyAgent(sessionId: string): Promise<void> {
		const stored = this.findStoredSession(sessionId);
		const managed = this.runtimes.get(sessionId);
		const projectId = stored?.projectId ?? managed?.projectId;
		if (!projectId) return;
		await this.disposeRuntime(sessionId, true);
		if (stored) {
			try {
				fs.unlinkSync(stored.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		if (this.activeSessionId === sessionId) this.activeSessionId = null;
		await this.refreshProjectSessions(projectId);
		this.emit({ type: "agent:destroyed", agentId: sessionId });
		this.emitSessionList(projectId);
	}

	private sessionManagerFor(sessionId: string): SessionManager | null {
		const managed = this.runtimes.get(sessionId);
		if (managed) return managed.runtime.session.sessionManager;
		const stored = this.findStoredSession(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : null;
	}

	async sendMessage(sessionId: string, text: string, images?: ImageContent[]): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void session
				.prompt(text, {
					images,
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
					else this.emitError(error, sessionId);
				});
		});
	}

	async abortAgent(sessionId: string): Promise<void> {
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		this.cancelPendingPermissions(sessionId);
		this.cancelPlanInteractions(sessionId, "Stopped by user");
		await managed.runtime.session.abort();
	}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		const slash = modelKey.indexOf("/");
		if (slash <= 0) throw new Error(`Model key must be in provider/model form: ${modelKey}`);
		const model = this.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${modelKey}`);
		await session.setModel(model);
		this.emitSessionUpdated(sessionId);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		const managed = await this.ensureRuntime(sessionId);
		managed.runtime.session.setThinkingLevel(level);
	}

	async compressSession(sessionId: string): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		if (!session.isStreaming) await session.compact();
	}

	renameAgent(sessionId: string, name: string): void {
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		if (!trimmed) return;
		const managed = this.runtimes.get(sessionId);
		if (managed) {
			managed.runtime.session.setSessionName(trimmed);
		} else {
			const manager = this.sessionManagerFor(sessionId);
			manager?.appendSessionInfo(trimmed);
		}
		const stored = this.findStoredSession(sessionId);
		if (stored) stored.name = trimmed;
		this.emitSessionUpdated(sessionId);
		if (stored) this.emitSessionList(stored.projectId);
	}

	async navigateTreeSession(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		const result = await session.navigateTree(entryId, opts);
		if (!result.cancelled) this.emitSessionState(sessionId, "navigate");
		return result;
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		return this.withForkLock(sessionId, async () => {
			const managed = await this.ensureRuntime(sessionId);
			const sourceSession = managed.runtime.session;
			if (sourceSession.isStreaming || sourceSession.isRetrying || sourceSession.isCompacting) {
				throw new Error("Stop the session before forking");
			}
			const sourceFile = sourceSession.sessionFile;
			if (!sourceFile) throw new Error("Source session not persisted");
			if (!sourceSession.sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

			const runner = sourceSession.extensionRunner;
			if (runner.hasHandlers("session_before_fork")) {
				const hookResult = await runner.emit({ type: "session_before_fork", entryId, position: "at" as const });
				if (hookResult?.cancel === true) throw new Error("Fork was cancelled by an extension");
			}

			// createBranchedSession mutates its SessionManager. Always use an
			// independent manager so the source runtime remains bound to A.
			const forkManager = SessionManager.open(sourceFile, sourceSession.sessionManager.getSessionDir());
			let forkedPath: string | undefined;
			let forkedSessionId: string | undefined;
			try {
				forkedPath = forkManager.createBranchedSession(entryId);
				if (!forkedPath) throw new Error("Failed to create forked session");
				forkedSessionId = forkManager.getSessionId();
				const forkedManaged = await this.createManagedRuntime(
					forkManager.getCwd(),
					forkManager,
					managed.projectId,
					Date.now(),
					{ type: "session_start", reason: "fork", previousSessionFile: sourceFile },
				);
				const session = forkedManaged.runtime.session;
				if (opts?.name?.trim()) session.setSessionName(opts.name.trim().slice(0, MAX_NAME_LENGTH));
				if (!session.sessionFile) throw new Error("Forked session was not persisted");
				await this.refreshProjectSessions(managed.projectId);
				this.activeProjectId = managed.projectId;
				this.activeSessionId = session.sessionId;
				this.emitSessionState(session.sessionId, "initial");
				return { agentId: session.sessionId, sessionFilePath: session.sessionFile };
			} catch (error) {
				if (forkedSessionId && this.runtimes.has(forkedSessionId)) await this.disposeRuntime(forkedSessionId, true);
				if (forkedPath && existsSync(forkedPath)) fs.unlinkSync(forkedPath);
				throw error;
			}
		});
	}

	private async withForkLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.forkOperationTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.forkOperationTails.set(sessionId, tail);
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.forkOperationTails.get(sessionId) === tail) this.forkOperationTails.delete(sessionId);
		}
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		const manager = this.sessionManagerFor(sessionId);
		if (!manager) return;
		const leaf = manager.getLeafId();
		manager.appendLabelChange(entryId, label?.trim() || undefined);
		if (leaf) manager.branch(leaf);
		else manager.resetLeaf();
		this.emitSessionState(sessionId, "navigate");
	}

	private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		this.emit({ type: "session:sdk-event", sessionId, event });
		switch (event.type) {
			case "agent_end":
				this.persistPermissionModeIfPossible(sessionId);
				this.persistPlanToolSnapshotIfPossible(sessionId);
				// The SDK can still report isStreaming=true momentarily after the turn
				// has ended. Force the post-end reports to false until the next run starts.
				this.streamingStates.set(sessionId, event.willRetry ? "retrying" : "idle");
				this.emitSessionState(sessionId, "agent_end");
				this.refreshAfterTurn(sessionId).catch((error) => this.emitError(error, sessionId));
				break;
			case "agent_start":
				this.streamingStates.set(sessionId, "streaming");
				this.emitSessionUpdated(sessionId);
				break;
			case "thinking_level_changed":
			case "session_info_changed":
			case "compaction_start":
			case "compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
				this.emitSessionUpdated(sessionId);
				break;
		}
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		const projectId = this.runtimes.get(sessionId)?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (!projectId) return;
		await this.refreshProjectSessions(projectId);
		this.emitSessionUpdated(sessionId);
		this.emitSessionList(projectId);
	}

	private emitSessionState(targetSessionId?: string, reason: SessionSnapshotEnvelope["reason"] = "activate"): void {
		const sessionId = targetSessionId ?? this.activeSessionId;
		if (!sessionId) return;
		const managed = this.runtimes.get(sessionId);
		const projectId = managed?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (projectId) this.emitSessionList(projectId);
		if (managed) {
			const session = managed.runtime.session;
			this.emit({
				type: "session:snapshot",
				sessionId,
				reason,
				leafId: session.sessionManager.getLeafId(),
				entries: session.sessionManager.getBranch(),
				runtime: {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: this.isStreaming(sessionId, session.isStreaming),
					isRetrying: session.isRetrying,
					isCompacting: session.isCompacting,
					retryAttempt: session.retryAttempt,
					steering: session.getSteeringMessages(),
					followUp: session.getFollowUpMessages(),
					stats: session.getSessionStats(),
					contextUsage: session.getContextUsage(),
				},
			});
		}
		this.emitSessionUpdated(sessionId);
	}

	private emitSessionUpdated(sessionId: string): void {
		const info = this.getAgentInfo(sessionId);
		if (info) this.emit({ type: "agent:updated", agentId: info.id, agent: info });
	}

	private emitSessionList(projectId: string): void {
		this.emit({ type: "agent:list", projectId, agents: this.listAgentsInProject(projectId) });
	}

	private emitProjectList(): void {
		this.emit({ type: "project:list", projects: this.listProjects(), activeProjectId: this.activeProjectId });
	}

	setApiKey(provider: string, key: string): void {
		const trimmed = key.trim();
		if (trimmed) this.authStorage.set(provider, { type: "api_key", key: trimmed });
		else this.authStorage.remove(provider);
	}

	getApiKey(provider: string): string | undefined {
		const credential = this.authStorage.get(provider);
		return credential?.type === "api_key" ? credential.key : undefined;
	}

	async testApiKey(provider: string, key: string) {
		const validator = await import("./provider-validator.js");
		return validator.testApiKey(provider, key);
	}

	async testEnvKey(provider: string) {
		const validator = await import("./provider-validator.js");
		return validator.testConfiguredProvider(this.modelRegistry, provider);
	}

	getAvailableModelsSync() {
		return this.modelRegistry
			.getAll()
			.filter((model) => this.modelRegistry.getProviderAuthStatus(model.provider).configured)
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name ?? model.id,
				reasoning: model.reasoning ?? false,
				contextWindow: model.contextWindow ?? 128000,
				maxTokens: model.maxTokens ?? 16384,
				cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
			}));
	}

	async getAvailableModels() {
		return this.getAvailableModelsSync();
	}

	async getProviders(): Promise<Array<{ id: string; name: string; hasCredentials: boolean; models: string[] }>> {
		const providers = new Map<string, string>();
		for (const model of this.modelRegistry.getAll()) {
			providers.set(model.provider, this.modelRegistry.getProviderDisplayName(model.provider));
		}
		return Array.from(providers, ([id, name]) => ({
			id,
			name,
			hasCredentials: this.modelRegistry.getProviderAuthStatus(id).configured,
			models: this.modelRegistry
				.getAvailable()
				.filter((model) => model.provider === id)
				.map((model) => model.id),
		}));
	}

	async getProviderSettings() {
		const providers = await this.getProviders();
		return providers.map((provider) => {
			const auth = this.modelRegistry.getProviderAuthStatus(provider.id);
			const models = this.getAvailableModelsSync().filter((model) => model.provider === provider.id);
			return {
				id: provider.id,
				name: provider.name,
				hasKey: provider.hasCredentials,
				envVar: auth.source === "environment" ? auth.label : undefined,
				modelsAvailable: models.length,
				models,
				authSource: auth.source,
				envLabel: auth.label,
			};
		});
	}

	getPermissionMode(sessionId: string): PermissionMode {
		const cached = this.permissionModesBySession.get(sessionId);
		if (cached) return cached;
		const manager = this.sessionManagerFor(sessionId);
		if (!manager) throw new Error(`Session ${sessionId} not found`);
		return this.restorePermissionMode(sessionId, manager);
	}

	async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		await this.applyPermissionMode(sessionId, mode, { internal: false, updateDefault: true });
	}

	private async applyPermissionMode(
		sessionId: string,
		mode: PermissionMode,
		options: { internal: boolean; updateDefault: boolean },
	): Promise<void> {
		const managed = await this.ensureRuntime(sessionId);
		const previousMode = this.getPermissionMode(sessionId);
		if (previousMode === mode) return;

		if (!options.internal) this.cancelPlanInteractions(sessionId, "Permission mode was changed manually");
		if (mode === "plan") this.capturePrePlanTools(sessionId);

		this.permissionModesBySession.set(sessionId, mode);
		this.sessionAllowedTools.delete(sessionId);
		this.dirtyPermissionModes.add(sessionId);
		if (mode === "plan") this.restrictToolsForPlan(sessionId);
		else if (previousMode === "plan") this.restorePrePlanTools(sessionId);
		this.persistPermissionModeIfPossible(sessionId);
		this.persistPlanToolSnapshotIfPossible(sessionId);

		if (options.updateDefault) {
			this.defaultPermissionMode = mode;
			await this.userSettings.update({ permissionMode: mode });
		}

		if (!options.internal && managed.runtime.session.isStreaming && (previousMode === "plan" || mode === "plan")) {
			await managed.runtime.session.abort();
		}
	}

	handlePermissionResponse(payload: PermissionRespondPayload): boolean {
		return this.finishPermissionRequest(payload.requestId, payload.action);
	}

	private restorePermissionMode(sessionId: string, manager: SessionManager): PermissionMode {
		let mode = this.defaultPermissionMode;
		let hasSavedMode = false;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PERMISSION_MODE_ENTRY_TYPE) continue;
			const savedMode = (entry.data as { mode?: unknown } | undefined)?.mode;
			if (isPermissionMode(savedMode)) {
				mode = savedMode;
				hasSavedMode = true;
			}
		}
		this.permissionModesBySession.set(sessionId, mode);
		if (!hasSavedMode) {
			// Lock the inherited default to this session so a later selection in
			// another session cannot change it after this runtime is reopened.
			if (manager.isPersisted()) {
				manager.appendCustomEntry(PERMISSION_MODE_ENTRY_TYPE, { mode });
			} else {
				this.dirtyPermissionModes.add(sessionId);
			}
		}
		return mode;
	}

	private restorePlanToolSnapshot(sessionId: string, manager: SessionManager): void {
		let snapshot: string[] | undefined;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY_TYPE) continue;
			const tools = (entry.data as { prePlanActiveTools?: unknown } | undefined)?.prePlanActiveTools;
			if (Array.isArray(tools) && tools.every((tool) => typeof tool === "string")) snapshot = [...tools];
		}
		if (snapshot && this.permissionModesBySession.get(sessionId) === "plan") {
			this.prePlanToolsBySession.set(sessionId, snapshot);
		}
	}

	private capturePrePlanTools(sessionId: string): void {
		if (this.prePlanToolsBySession.has(sessionId)) return;
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session) return;
		this.prePlanToolsBySession.set(sessionId, session.getActiveToolNames());
		this.dirtyPlanToolSnapshots.add(sessionId);
	}

	private restrictToolsForPlan(sessionId: string): void {
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session) return;
		const configured = new Set(session.getAllTools().map((tool) => tool.name));
		const previouslyActive = new Set(this.prePlanToolsBySession.get(sessionId) ?? []);
		session.setActiveToolsByName(
			PLAN_TOOL_NAMES.filter(
				(tool) =>
					configured.has(tool) &&
					(tool === "AskUserQuestion" || tool === "ExitPlanMode" || previouslyActive.has(tool)),
			),
		);
	}

	private restorePrePlanTools(sessionId: string): void {
		const session = this.runtimes.get(sessionId)?.runtime.session;
		const snapshot = this.prePlanToolsBySession.get(sessionId);
		if (!session || !snapshot) return;
		const configured = new Set(session.getAllTools().map((tool) => tool.name));
		session.setActiveToolsByName(snapshot.filter((tool) => configured.has(tool)));
		this.prePlanToolsBySession.delete(sessionId);
		this.dirtyPlanToolSnapshots.delete(sessionId);
	}

	private syncPlanToolState(sessionId: string): void {
		if (this.getPermissionMode(sessionId) !== "plan") return;
		this.capturePrePlanTools(sessionId);
		this.restrictToolsForPlan(sessionId);
		this.persistPlanToolSnapshotIfPossible(sessionId);
	}

	private persistPlanToolSnapshotIfPossible(sessionId: string): void {
		if (!this.dirtyPlanToolSnapshots.has(sessionId)) return;
		const session = this.runtimes.get(sessionId)?.runtime.session;
		const tools = this.prePlanToolsBySession.get(sessionId);
		if (!session || !tools || !session.sessionManager.isPersisted()) return;
		session.sessionManager.appendCustomEntry(PLAN_STATE_ENTRY_TYPE, { prePlanActiveTools: tools });
		this.dirtyPlanToolSnapshots.delete(sessionId);
	}

	private persistPermissionModeIfPossible(sessionId: string): void {
		if (!this.dirtyPermissionModes.has(sessionId)) return;
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session || !session.sessionManager.isPersisted()) return;
		const mode = this.permissionModesBySession.get(sessionId);
		if (!mode) return;
		session.sessionManager.appendCustomEntry(PERMISSION_MODE_ENTRY_TYPE, { mode });
		this.dirtyPermissionModes.delete(sessionId);
	}

	private finishPermissionRequest(requestId: string, action: "allow" | "deny" | "allow_always"): boolean {
		const pending = this.permissionAwaiting.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timeout);
		this.permissionAwaiting.delete(requestId);
		pending.resolve(action);
		this.emit({ type: "permission:resolved", agentId: pending.sessionId, requestId });
		return true;
	}

	private cancelPendingPermissions(sessionId: string): void {
		for (const [requestId, pending] of Array.from(this.permissionAwaiting.entries())) {
			if (pending.sessionId === sessionId) this.finishPermissionRequest(requestId, "deny");
		}
	}

	private createPermissionToolCallHandler(cwd: string): ToolCallHandler {
		// Pre-build the plan handler once; it's stateless so safe to reuse.
		const planHandler = createPlanModeHandler(cwd);

		return async (event, _ctx) => {
			const sessionId = _ctx.sessionManager.getSessionId();
			const mode = this.permissionModesBySession.get(sessionId) ?? this.defaultPermissionMode;

			// "always" mode — allow everything, no questions asked
			if (mode === "always") return {};

			// Plan mode — strict read-only fallback even for hidden or stale tools.
			if (mode === "plan") return planHandler(event, _ctx);

			// "ask" mode — prompt user for each intercepted tool call
			const toolName = event.toolName;
			const allowedTools = this.sessionAllowedTools.get(sessionId);
			if (allowedTools?.has(toolName)) return {};

			const requestId = uuidv4();
			const expiresAt = Date.now() + PERMISSION_TIMEOUT_MS;
			const askEvent: PermissionAskEvent = {
				toolName,
				toolInput: (event.input ?? {}) as Record<string, unknown>,
				toolDescription: `Tool: ${toolName}`,
				requestId,
				expiresAt,
			};

			const actionPromise = new Promise<"allow" | "deny" | "allow_always">((resolve) => {
				const timeout = setTimeout(() => {
					this.finishPermissionRequest(requestId, "deny");
				}, PERMISSION_TIMEOUT_MS);
				this.permissionAwaiting.set(requestId, { sessionId, resolve, timeout });
			});
			// Register the pending request before notifying the renderer so an
			// immediate response cannot race ahead of the resolver.
			this.emit({ type: "permission:ask", agentId: sessionId, event: askEvent });
			const action = await actionPromise;

			if (action === "allow_always") {
				const grants = this.sessionAllowedTools.get(sessionId) ?? new Set<string>();
				grants.add(toolName);
				this.sessionAllowedTools.set(sessionId, grants);
				return {};
			}
			if (action === "allow") return {};
			return { block: true, reason: `用户拒绝了 ${toolName} 工具调用` };
		};
	}

	private reservePlanInteraction(sessionId: string, kind: "question" | "approval", requestId: string): void {
		if (this.planInteractionBySession.has(sessionId)) {
			throw new Error("This session already has a pending Plan interaction");
		}
		this.planInteractionBySession.set(sessionId, { kind, requestId });
	}

	private abortListener(signal: AbortSignal | undefined, onAbort: () => void): () => void {
		if (!signal) return () => {};
		signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	}

	private async requestPlanQuestions(
		sessionId: string,
		questions: PlanQuestion[],
		signal?: AbortSignal,
	): Promise<PlanQuestionOutcome> {
		if (this.getPermissionMode(sessionId) !== "plan") {
			return { status: "cancelled", reason: "Session is no longer in Plan mode" };
		}
		if (signal?.aborted) return { status: "cancelled", reason: "Planning turn was aborted" };

		const requestId = uuidv4();
		const request: PlanQuestionRequest = { requestId, sessionId, questions };
		this.reservePlanInteraction(sessionId, "question", requestId);
		return new Promise<PlanQuestionOutcome>((resolve) => {
			const pending: PendingPlanQuestion = { request, resolve, removeAbortListener: () => {} };
			this.planQuestionsAwaiting.set(requestId, pending);
			pending.removeAbortListener = this.abortListener(signal, () => {
				this.finishPlanQuestion(requestId, { status: "cancelled", reason: "Planning turn was aborted" });
			});
			if (signal?.aborted) {
				this.finishPlanQuestion(requestId, { status: "cancelled", reason: "Planning turn was aborted" });
			} else {
				this.emit({ type: "plan:question-requested", agentId: sessionId, request });
			}
		});
	}

	handlePlanQuestionResponse(payload: PlanQuestionResponse): boolean {
		const pending = this.planQuestionsAwaiting.get(payload.requestId);
		if (!pending || pending.request.sessionId !== payload.sessionId) return false;
		const answers: Record<string, string> = Object.create(null);
		for (const question of pending.request.questions) {
			const answer = payload.answers[question.question];
			if (typeof answer !== "string" || !answer.trim()) return false;
			answers[question.question] = answer.trim();
		}
		if (Object.keys(payload.answers).length !== pending.request.questions.length) return false;
		return this.finishPlanQuestion(payload.requestId, { status: "answered", answers });
	}

	private finishPlanQuestion(requestId: string, outcome: PlanQuestionOutcome): boolean {
		const pending = this.planQuestionsAwaiting.get(requestId);
		if (!pending) return false;
		this.planQuestionsAwaiting.delete(requestId);
		pending.removeAbortListener();
		const active = this.planInteractionBySession.get(pending.request.sessionId);
		if (active?.requestId === requestId) this.planInteractionBySession.delete(pending.request.sessionId);
		this.emit({ type: "plan:question-resolved", agentId: pending.request.sessionId, requestId });
		pending.resolve(outcome);
		return true;
	}

	private async ensurePlanDirectory(cwd: string): Promise<string> {
		const contextDir = path.join(cwd, ".context");
		const planDir = path.join(contextDir, "plan");
		for (const directory of [contextDir, planDir]) {
			await fs.promises.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
			const stat = await fs.promises.lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`Plan path must be a real directory, not a symlink: ${directory}`);
			}
		}
		return planDir;
	}

	private async writePlanAtomically(sessionId: string, cwd: string, plan: string): Promise<string> {
		if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error("Session ID is unsafe for a plan filename");
		const planDir = await this.ensurePlanDirectory(cwd);
		const filePath = path.join(planDir, `${sessionId}.md`);
		const temporaryPath = path.join(planDir, `.${sessionId}.${uuidv4()}.tmp`);
		try {
			await fs.promises.writeFile(temporaryPath, `${plan.trim()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await fs.promises.rename(temporaryPath, filePath);
		} finally {
			await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		}
		return filePath;
	}

	private appendPlanRecord(
		sessionId: string,
		data: {
			planId: string;
			status: "submitted" | "approved" | "rejected";
			filePath: string;
			plan?: string;
		},
	): void {
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session) throw new Error(`Session ${sessionId} is not live`);
		session.sessionManager.appendCustomEntry(PLAN_RECORD_ENTRY_TYPE, {
			...data,
			timestamp: new Date().toISOString(),
		});
	}

	private async requestPlanApproval(
		sessionId: string,
		plan: string,
		signal?: AbortSignal,
	): Promise<PlanApprovalOutcome> {
		if (this.getPermissionMode(sessionId) !== "plan") {
			return { status: "cancelled", reason: "Session is no longer in Plan mode" };
		}
		if (signal?.aborted) return { status: "cancelled", reason: "Planning turn was aborted" };
		const requestId = uuidv4();
		const planId = uuidv4();
		const managed = await this.ensureRuntime(sessionId);
		this.persistPlanToolSnapshotIfPossible(sessionId);
		this.reservePlanInteraction(sessionId, "approval", requestId);
		let filePath: string;
		try {
			filePath = await this.writePlanAtomically(sessionId, managed.runtime.cwd, plan);
			this.appendPlanRecord(sessionId, { planId, status: "submitted", filePath, plan });
		} catch (error) {
			const active = this.planInteractionBySession.get(sessionId);
			if (active?.requestId === requestId) this.planInteractionBySession.delete(sessionId);
			throw error;
		}
		const request: PlanApprovalRequest = { requestId, planId, sessionId, plan, filePath };

		return new Promise<PlanApprovalOutcome>((resolve) => {
			const pending: PendingPlanApproval = { request, resolve, removeAbortListener: () => {}, resolving: false };
			this.planApprovalsAwaiting.set(requestId, pending);
			pending.removeAbortListener = this.abortListener(signal, () => {
				this.finishPlanApproval(requestId, {
					status: "cancelled",
					planId,
					filePath,
					reason: "Planning turn was aborted",
				});
			});
			if (signal?.aborted) {
				this.finishPlanApproval(requestId, {
					status: "cancelled",
					planId,
					filePath,
					reason: "Planning turn was aborted",
				});
			} else {
				this.emit({ type: "plan:approval-requested", agentId: sessionId, request });
			}
		});
	}

	async handlePlanApprovalResponse(payload: PlanApprovalResponse): Promise<boolean> {
		const pending = this.planApprovalsAwaiting.get(payload.requestId);
		if (!pending || pending.resolving || pending.request.sessionId !== payload.sessionId) return false;
		pending.resolving = true;
		const { planId, filePath, sessionId } = pending.request;
		try {
			if (payload.action === "reject") {
				this.appendPlanRecord(sessionId, { planId, status: "rejected", filePath });
				return this.finishPlanApproval(payload.requestId, { status: "rejected", planId, filePath });
			}
			await this.applyPermissionMode(sessionId, "always", { internal: true, updateDefault: false });
			this.appendPlanRecord(sessionId, { planId, status: "approved", filePath });
			return this.finishPlanApproval(payload.requestId, { status: "approved", planId, filePath });
		} catch (error) {
			this.finishPlanApproval(payload.requestId, {
				status: "cancelled",
				planId,
				filePath,
				reason: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private finishPlanApproval(requestId: string, outcome: PlanApprovalOutcome): boolean {
		const pending = this.planApprovalsAwaiting.get(requestId);
		if (!pending) return false;
		this.planApprovalsAwaiting.delete(requestId);
		pending.removeAbortListener();
		const active = this.planInteractionBySession.get(pending.request.sessionId);
		if (active?.requestId === requestId) this.planInteractionBySession.delete(pending.request.sessionId);
		this.emit({ type: "plan:approval-resolved", agentId: pending.request.sessionId, requestId });
		pending.resolve(outcome);
		return true;
	}

	private cancelPlanInteractions(sessionId: string, reason: string): void {
		const interaction = this.planInteractionBySession.get(sessionId);
		if (!interaction) return;
		if (interaction.kind === "question") {
			this.finishPlanQuestion(interaction.requestId, { status: "cancelled", reason });
		} else {
			const request = this.planApprovalsAwaiting.get(interaction.requestId)?.request;
			this.finishPlanApproval(interaction.requestId, {
				status: "cancelled",
				planId: request?.planId,
				filePath: request?.filePath,
				reason,
			});
		}
	}

	getGeneralSettings(): UserSettings {
		return this.userSettings.getAll();
	}

	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		const settings = await this.userSettings.update(partial);
		if (partial.compactionEnabled !== undefined) {
			for (const managed of this.runtimes.values()) {
				managed.runtime.session.setAutoCompactionEnabled(partial.compactionEnabled);
			}
		}
		if (partial.permissionMode !== undefined) this.defaultPermissionMode = partial.permissionMode;
		return settings;
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		const settings = await this.userSettings.reset();
		this.defaultPermissionMode = settings.permissionMode;
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		return settings;
	}

	listSkillsForUI() {
		const activeRuntime = this.activeSessionId ? this.runtimes.get(this.activeSessionId)?.runtime : undefined;
		const loaded = activeRuntime?.services.resourceLoader.getSkills() ?? { skills: [], diagnostics: [] };
		return {
			skills: loaded.skills,
			diagnostics: loaded.diagnostics,
			importedPaths:
				activeRuntime?.services.settingsManager.getSkillPaths() ?? this.globalSettingsManager.getSkillPaths(),
		};
	}

	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const activeRuntime = this.activeSessionId ? this.runtimes.get(this.activeSessionId)?.runtime : undefined;
			const settingsManager = activeRuntime?.services.settingsManager ?? this.globalSettingsManager;
			const merged = Array.from(
				new Set(
					[...settingsManager.getSkillPaths(), ...paths]
						.map((item) => (item.startsWith("~") ? join(homedir(), item.slice(1)) : item))
						.filter((item) => existsSync(item)),
				),
			);
			settingsManager.setSkillPaths(merged);
			await settingsManager.flush();
			await Promise.all(Array.from(this.runtimes.values()).map((managed) => managed.runtime.session.reload()));
			return { success: true, importedCount: merged.length };
		} catch (error) {
			return { success: false, importedCount: 0, error: error instanceof Error ? error.message : String(error) };
		}
	}

	detectCommonSkillPaths(): Array<{ tool: string; path: string; exists: boolean; skillCount: number }> {
		const candidates = [
			["Claude Code", join(homedir(), ".claude", "skills")],
			["Cursor", join(homedir(), ".cursor", "skills")],
			["OpenAI Codex", join(homedir(), ".codex", "skills")],
			["GitHub Copilot", join(homedir(), ".config", "github-copilot", "skills")],
		] as const;
		return candidates.map(([tool, skillPath]) => ({
			tool,
			path: skillPath,
			exists: existsSync(skillPath),
			skillCount: existsSync(skillPath)
				? fs.readdirSync(skillPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
				: 0,
		}));
	}

	onEvent(callback: EventCallback): () => void {
		this.eventCallbacks.push(callback);
		return () => {
			const index = this.eventCallbacks.indexOf(callback);
			if (index >= 0) this.eventCallbacks.splice(index, 1);
		};
	}

	private emit(event: MainToRendererEvent): void {
		for (const callback of this.eventCallbacks) callback(event);
	}

	private emitError(error: unknown, sessionId?: string): void {
		this.emit({
			type: "error",
			agentId: sessionId ?? this.activeSessionId ?? undefined,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
