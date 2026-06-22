import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
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
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { v4 as uuidv4 } from "uuid";
import {
	createPermissionExtensionFactory,
	createPlanModeHandler,
	type ToolCallHandler,
} from "./extensions/permission-extension.js";
import { createMcpExtensionFactory } from "./mcp/mcp-extension.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { migrateLegacySettings } from "./migrate-settings.js";
import {
	ensureLookDir,
	getAuthPath,
	getLookDir,
	getModelsPath,
	getProjectsIndexPath,
	getSessionsDir,
	getUiSettingsPath,
} from "./shared/look-storage.js";
import { convertPiMessage } from "./shared/message-convert.js";
import type {
	AgentInfo,
	ContextUsageInfo,
	ForkedSessionResult,
	MainToRendererEvent,
	NavigateTreeResult,
	PermissionAskEvent,
	PermissionMode,
	PermissionRespondPayload,
	PiMessage,
	PiToolCallBlock,
	ProjectInfo,
	SessionForkPoint,
	SessionStatus,
	SessionTreeNode,
	ThinkingLevel,
	UsageSnapshot,
} from "./shared/types.js";
import { type UserSettings, UserSettingsStore } from "./user-settings.js";

export type EventCallback = (event: MainToRendererEvent) => void;

interface StoredSession extends PiSessionInfo {
	projectId: string;
}

interface ManagedRuntime {
	readonly runtime: AgentSessionRuntime;
	readonly projectId: string;
	readonly createdAt: number;
	status: SessionStatus;
	streamSequence: number;
	streamId: string | null;
	unsubscribe: () => void;
}

const MAX_NAME_LENGTH = 80;

function emptyUsageSnapshot(): UsageSnapshot {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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
	private resourceInitializationTail: Promise<void> = Promise.resolve();
	private activeProjectId: string | null = null;
	private activeSessionId: string | null = null;
	private _mcpManager: McpManager | null = null;
	private _permissionMode: PermissionMode = "ask";
	/** Permission ask mode: pending requests keyed by requestId. */
	private permissionAwaiting = new Map<string, { resolve: (action: "allow" | "deny" | "allow_always") => void }>();
	/** "ask" mode: tools allowed for the rest of this session (set by "Always Allow"). */
	private sessionAllowedTools = new Set<string>();

	constructor() {
		ensureLookDir();
		const migration = migrateLegacySettings();
		if (migration.migrated && migration.keys.length > 0) {
			console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
		}
		this.authStorage = AuthStorage.create(getAuthPath());
		this.modelRegistry = ModelRegistry.create(this.authStorage, getModelsPath());
		this.trustStore = new ProjectTrustStore(getLookDir());
		this.globalSettingsManager = SettingsManager.create(getLookDir(), getLookDir());
		this.userSettings = new UserSettingsStore(this.globalSettingsManager, getUiSettingsPath());
		this._permissionMode = this.userSettings.getAll().permissionMode;
		this.globalSettingsManager.setDefaultProjectTrust(this._permissionMode === "always" ? "always" : "ask");
		this.projectsIndexPath = getProjectsIndexPath();
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
			runningCount: runtimeIds.filter((sessionId) => this.runtimes.get(sessionId)?.status !== "idle").length,
		});
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		const sessions = this.sessionsByProject.get(projectId) ?? [];
		const runtimeIds = Array.from(this.runtimes.entries())
			.filter(([, managed]) => managed.projectId === projectId)
			.map(([sessionId]) => sessionId);
		await Promise.all(runtimeIds.map((sessionId) => this.disposeRuntime(sessionId, true)));
		for (const session of sessions) {
			try {
				fs.unlinkSync(session.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		this.sessionsByProject.delete(projectId);
		this.projects.delete(projectId);
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
		const sessions = (await SessionManager.list(project.cwd, getSessionsDir())).map((session) => ({
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
			status: managed?.status ?? "idle",
			messageCount: stats?.totalMessages ?? session.messageCount,
			createdAt: session.created.getTime(),
			usage: stats
				? {
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						cacheReadTokens: stats.tokens.cacheRead,
						cacheWriteTokens: stats.tokens.cacheWrite,
						totalTokens: stats.tokens.total,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
					}
				: emptyUsageSnapshot(),
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
			status: managed.status,
			messageCount: stats.totalMessages,
			createdAt: managed.createdAt,
			usage: {
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				cacheReadTokens: stats.tokens.cacheRead,
				cacheWriteTokens: stats.tokens.cacheWrite,
				totalTokens: stats.tokens.total,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
			},
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

	listAgentsWithHistory(): { agents: AgentInfo[]; history: Record<string, PiMessage[]> } {
		const agents = this.listAgents();
		const history: Record<string, PiMessage[]> = {};
		for (const info of agents) {
			const messages = this.getMessages(info.id);
			if (messages.length > 0) history[info.id] = messages;
		}
		return { agents, history };
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		const managed = this.runtimes.get(sessionId);
		if (managed) return this.runtimeInfo(sessionId, managed);
		const session = this.findStoredSession(sessionId);
		return session ? this.sessionInfo(session) : undefined;
	}

	private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			await this.getMcpManager().connectAll();
			return this.withResourceInitialization(async () => {
				const settingsManager = SettingsManager.create(cwd, getLookDir());
				const trusted = this.resolveProjectTrust(cwd);
				settingsManager.setProjectTrusted(trusted);
				const services = await createAgentSessionServices({
					cwd,
					agentDir: getLookDir(),
					authStorage: this.authStorage,
					modelRegistry: this.modelRegistry,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: this.buildExtensionFactories(cwd),
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

	private buildExtensionFactories(cwd: string): ExtensionFactory[] {
		// Always register the permission extension — it checks
		// this._permissionMode at runtime so mode switches are
		// instantaneous and never require a runtime rebuild.
		const handler = this.createPermissionToolCallHandler(cwd);
		return [createPermissionExtensionFactory(handler), createMcpExtensionFactory(this.getMcpManager())];
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
	): Promise<ManagedRuntime> {
		const runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
			cwd,
			agentDir: getLookDir(),
			sessionManager,
		});
		return this.bindRuntime(runtime, projectId, createdAt);
	}

	private async bindRuntime(
		runtime: AgentSessionRuntime,
		projectId: string,
		createdAt: number,
	): Promise<ManagedRuntime> {
		const session = runtime.session;
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		const managed: ManagedRuntime = {
			runtime,
			projectId,
			createdAt,
			status: "idle",
			streamSequence: 0,
			streamId: null,
			unsubscribe: () => {},
		};
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		runtime.setRebindSession(async (nextSession) => this.rebindRuntime(runtime, nextSession));
		this.runtimes.set(session.sessionId, managed);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
		return managed;
	}

	private async rebindRuntime(runtime: AgentSessionRuntime, session: AgentSession): Promise<void> {
		const previousEntry = Array.from(this.runtimes.entries()).find(([, managed]) => managed.runtime === runtime);
		if (!previousEntry) throw new Error("Runtime replacement lost its registry entry");
		const [previousSessionId, managed] = previousEntry;
		managed.unsubscribe();
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		this.runtimes.delete(previousSessionId);
		managed.status = "idle";
		managed.streamId = null;
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		this.runtimes.set(session.sessionId, managed);
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
		if (abort && managed.runtime.session.isStreaming) await managed.runtime.session.abort();
		managed.unsubscribe();
		this.runtimes.delete(sessionId);
		await managed.runtime.dispose();
	}

	async disposeAllRuntimes(): Promise<void> {
		await Promise.all(Array.from(this.runtimes.keys()).map((sessionId) => this.disposeRuntime(sessionId, true)));
	}

	async activateSession(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.runtimes.has(sessionId)) return;
		const previousSessionId = this.activeSessionId;
		const managed = await this.ensureRuntime(sessionId);
		this.activeProjectId = managed.projectId;
		this.activeSessionId = sessionId;
		await this.refreshProjectSessions(managed.projectId);
		if (previousSessionId && previousSessionId !== sessionId) {
			const previous = this.runtimes.get(previousSessionId);
			if (previous?.status === "idle") {
				await this.disposeRuntime(previousSessionId);
				this.emitSessionList(previous.projectId);
			}
		}
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

		const previousSessionId = this.activeSessionId;
		const managed = await this.createManagedRuntime(
			project.cwd,
			SessionManager.create(project.cwd, getSessionsDir()),
			projectId,
		);
		const session = managed.runtime.session;
		session.setSessionName((input.name?.trim() || "New chat").slice(0, MAX_NAME_LENGTH));
		this.activeProjectId = projectId;
		this.activeSessionId = session.sessionId;
		if (previousSessionId && previousSessionId !== session.sessionId) {
			const previous = this.runtimes.get(previousSessionId);
			if (previous?.status === "idle") {
				await this.disposeRuntime(previousSessionId);
				this.emitSessionList(previous.projectId);
			}
		}
		await this.refreshProjectSessions(projectId);
		this.emit({
			type: "agent:created",
			agentId: session.sessionId,
			agent: this.runtimeInfo(session.sessionId, managed),
		});
		this.emitSessionState(session.sessionId);
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

	getMessages(sessionId: string): PiMessage[] {
		const manager = this.sessionManagerFor(sessionId);
		return manager ? this.extractMessages(manager, sessionId) : [];
	}

	private sessionManagerFor(sessionId: string): SessionManager | null {
		const managed = this.runtimes.get(sessionId);
		if (managed) return managed.runtime.session.sessionManager;
		const stored = this.findStoredSession(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : null;
	}

	async sendMessage(sessionId: string, text: string): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
	}

	async abortAgent(sessionId: string): Promise<void> {
		const managed = this.runtimes.get(sessionId);
		if (managed) await managed.runtime.session.abort();
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

	getContextUsage(sessionId: string): ContextUsageInfo | undefined {
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session) return undefined;
		const usage = session.getContextUsage();
		if (!usage) return undefined;
		const percentage = usage.percent === null ? 0 : Math.min(100, Math.max(0, Math.round(usage.percent)));
		return {
			percentage,
			usedTokens: usage.tokens ?? 0,
			totalTokens: usage.contextWindow,
			level: percentage >= 80 ? "critical" : percentage >= 60 ? "warning" : "safe",
			compacting: session.isCompacting,
		};
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

	getSessionTree(sessionId: string): SessionTreeNode | null {
		const manager = this.sessionManagerFor(sessionId);
		if (!manager) return null;
		const roots = manager.getTree();
		if (roots.length === 0) {
			return {
				id: "__empty__",
				parentId: null,
				type: "session_info",
				timestamp: new Date(0).toISOString(),
				children: [],
			};
		}
		return this.toRendererTreeNode(roots[0]);
	}

	getForkPoints(sessionId: string): SessionForkPoint[] {
		const session = this.runtimes.get(sessionId)?.runtime.session;
		if (!session) return [];
		return session.getUserMessagesForForking().map(({ entryId, text }) => ({
			entryId,
			text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
			timestamp: session.sessionManager.getEntry(entryId)?.timestamp ?? new Date().toISOString(),
		}));
	}

	async navigateTreeSession(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		const result = await session.navigateTree(entryId, opts);
		if (!result.cancelled) this.emitSessionState(sessionId);
		return result;
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		const managed = await this.ensureRuntime(sessionId);
		if (managed.runtime.session.isStreaming) throw new Error("Stop the session before forking");
		const sourceFile = managed.runtime.session.sessionFile;
		if (!sourceFile) throw new Error("Source session not persisted");

		// Fire extension hook (normally called by runtime.fork, but we bypass fork
		// so the source runtime stays alive for parallel sessions).
		const runner = managed.runtime.session.extensionRunner;
		if (runner.hasHandlers("session_before_fork")) {
			const hookResult = await runner.emit({
				type: "session_before_fork",
				entryId,
				position: "at" as const,
			});
			if (hookResult?.cancel === true) throw new Error("Fork was cancelled by an extension");
		}

		// Create branched session file directly — no source runtime teardown.
		const forkedPath = managed.runtime.session.sessionManager.createBranchedSession(entryId);
		if (!forkedPath) throw new Error("Failed to create forked session");

		// Spin up an independent runtime for the forked session.
		const forkedManager = SessionManager.open(forkedPath);
		const forkedManaged = await this.createManagedRuntime(
			forkedManager.getCwd(),
			forkedManager,
			managed.projectId,
			Date.now(),
		);

		const session = forkedManaged.runtime.session;
		if (opts?.name?.trim()) session.setSessionName(opts.name.trim().slice(0, MAX_NAME_LENGTH));
		const projectId = managed.projectId;
		if (!projectId || !session.sessionFile) throw new Error("Forked session was not persisted");
		await this.refreshProjectSessions(projectId);
		this.activeProjectId = projectId;
		this.activeSessionId = session.sessionId;
		this.emitSessionState(session.sessionId);
		return { agentId: session.sessionId, sessionFilePath: session.sessionFile };
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		const manager = this.sessionManagerFor(sessionId);
		if (!manager) return;
		const leaf = manager.getLeafId();
		manager.appendLabelChange(entryId, label?.trim() || undefined);
		if (leaf) manager.branch(leaf);
		else manager.resetLeaf();
		this.emitTree(sessionId);
	}

	private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		const rendererEvent = this.toRendererEvent(sessionId, event);
		if (rendererEvent) this.emit(rendererEvent);
		switch (event.type) {
			case "agent_start":
				this.updateSessionStatus(sessionId, "thinking");
				break;
			case "tool_execution_start":
				this.updateSessionStatus(sessionId, "working");
				break;
			case "agent_end":
				this.updateSessionStatus(sessionId, "idle");
				this.refreshAfterTurn(sessionId).catch((error) => this.emitError(error, sessionId));
				break;
			case "message_end":
				this.emitContextUsage(sessionId);
				break;
			case "compaction_start":
				this.emit({ type: "agent:compacting", agentId: sessionId, compacting: true });
				break;
			case "compaction_end":
				this.emit({ type: "agent:compacting", agentId: sessionId, compacting: false });
				break;
			case "thinking_level_changed":
			case "session_info_changed":
				this.emitSessionUpdated(sessionId);
				break;
		}
	}

	private toRendererEvent(sessionId: string, event: AgentSessionEvent): MainToRendererEvent | null {
		const managed = this.runtimes.get(sessionId);
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			if (!managed) return null;
			if (event.type === "message_start" || !managed.streamId) {
				managed.streamId = `stream:${sessionId}:${++managed.streamSequence}`;
			}
			const rendererEvent = {
				...event,
				type: `agent:${event.type}`,
				agentId: sessionId,
				message: { ...event.message, id: managed.streamId },
			} as MainToRendererEvent;
			if (event.type === "message_end") managed.streamId = null;
			return rendererEvent;
		}
		return { ...event, type: `agent:${event.type}`, agentId: sessionId } as MainToRendererEvent;
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		const projectId = this.runtimes.get(sessionId)?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (!projectId) return;
		await this.refreshProjectSessions(projectId);
		this.emit({ type: "agent:history", agentId: sessionId, messages: this.getMessages(sessionId) });
		this.emitTree(sessionId);
		this.emitSessionUpdated(sessionId);
		this.emitSessionList(projectId);
	}

	private emitSessionState(targetSessionId?: string): void {
		const sessionId = targetSessionId ?? this.activeSessionId;
		if (!sessionId) return;
		const projectId = this.runtimes.get(sessionId)?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (projectId) this.emitSessionList(projectId);
		this.emit({ type: "agent:history", agentId: sessionId, messages: this.getMessages(sessionId) });
		this.emitTree(sessionId);
		this.emitSessionUpdated(sessionId);
	}

	private emitTree(sessionId: string): void {
		const manager = this.sessionManagerFor(sessionId);
		const tree = this.getSessionTree(sessionId);
		if (manager && tree) {
			this.emit({ type: "agent:tree-changed", agentId: sessionId, leafId: manager.getLeafId(), tree });
		}
	}

	private emitContextUsage(sessionId: string): void {
		const usage = this.getContextUsage(sessionId);
		if (usage) this.emit({ type: "agent:context-usage", agentId: sessionId, usage });
	}

	private updateSessionStatus(sessionId: string, status: SessionStatus): void {
		const managed = this.runtimes.get(sessionId);
		if (managed) managed.status = status;
		this.emit({ type: "agent:status", agentId: sessionId, status });
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

	private toRendererTreeNode(node: any): SessionTreeNode {
		const entry = node.entry;
		const result: SessionTreeNode = {
			id: entry.id,
			parentId: entry.parentId,
			type: entry.type,
			timestamp: entry.timestamp,
			children: (node.children ?? []).map((child: any) => this.toRendererTreeNode(child)),
		};
		if (entry.type === "message") {
			result.role = entry.message.role;
			result.textPreview = this.previewText(entry.message).slice(0, 120);
		} else if (entry.type === "branch_summary") result.summary = entry.summary;
		else if (entry.type === "label") result.label = entry.label;
		return result;
	}

	private previewText(message: any): string {
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text ?? "")
			.join(" ")
			.trim();
	}

	private extractMessages(manager: SessionManager, sessionId: string): PiMessage[] {
		const messages: PiMessage[] = [];
		for (const entry of manager.getBranch()) {
			if (entry.type === "branch_summary") {
				messages.push(
					convertPiMessage(
						{ role: "branchSummary", summary: entry.summary, timestamp: new Date(entry.timestamp).getTime() },
						sessionId,
						entry.id,
					),
				);
				continue;
			}
			if (entry.type !== "message") continue;
			if (["bashExecution", "custom", "compactionSummary"].includes(entry.message.role)) continue;
			messages.push(convertPiMessage(entry.message, sessionId, entry.id));
		}
		for (const toolResult of messages.filter((message) => message.role === "tool")) {
			const toolCallId = (toolResult as any)._toolCallId as string | undefined;
			if (!toolCallId) continue;
			for (const assistant of messages.filter((message) => message.role === "assistant")) {
				const block = assistant.contentBlocks.find(
					(content) => content.type === "toolCall" && content.id === toolCallId,
				) as PiToolCallBlock | undefined;
				if (!block) continue;
				block.result = toolResult.contentBlocks
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join("\n");
				block.isError = (toolResult as any)._isError ?? false;
				block.status = block.isError ? "error" : "success";
			}
		}
		return messages;
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

	getPermissionMode(): PermissionMode {
		return this._permissionMode;
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		if (mode === this._permissionMode) return;
		this._permissionMode = mode;
		this.sessionAllowedTools.clear();
		await this.userSettings.update({ permissionMode: mode });
		this.globalSettingsManager.setDefaultProjectTrust(mode === "always" ? "always" : "ask");
	}

	handlePermissionResponse(payload: PermissionRespondPayload): void {
		const pending = this.permissionAwaiting.get(payload.requestId);
		if (!pending) return;
		pending.resolve(payload.action);
		this.permissionAwaiting.delete(payload.requestId);
	}

	private createPermissionToolCallHandler(cwd: string): ToolCallHandler {
		// Pre-build the plan handler once; it's stateless so safe to reuse.
		const planHandler = createPlanModeHandler(cwd);

		return async (event, _ctx) => {
			// "always" mode — allow everything, no questions asked
			if (this._permissionMode === "always") return {};

			// "plan" mode — path-filtering via the pre-built handler
			if (this._permissionMode === "plan") return planHandler(event, _ctx);

			// "ask" mode — prompt user for each intercepted tool call
			const toolName = event.toolName;
			if (this.sessionAllowedTools.has(toolName)) return {};

			const requestId = uuidv4();
			const askEvent: PermissionAskEvent = {
				toolName,
				toolInput: (event.input ?? {}) as Record<string, unknown>,
				toolDescription: `Tool: ${toolName}`,
				requestId,
			};

			const activeSessionId = this.activeSessionId;
			this.emit({ type: "permission:ask", agentId: activeSessionId ?? "", event: askEvent });

			const action = await new Promise<"allow" | "deny" | "allow_always">((resolve) => {
				this.permissionAwaiting.set(requestId, { resolve });
				setTimeout(() => {
					if (this.permissionAwaiting.has(requestId)) {
						this.permissionAwaiting.delete(requestId);
						resolve("deny");
					}
				}, 30_000);
			});

			if (action === "allow_always") {
				this.sessionAllowedTools.add(toolName);
				return {};
			}
			if (action === "allow") return {};
			return { block: true, reason: `用户拒绝了 ${toolName} 工具调用` };
		};
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
		if (partial.permissionMode !== undefined && partial.permissionMode !== this._permissionMode) {
			await this.setPermissionMode(partial.permissionMode);
		}
		return settings;
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		return this.userSettings.reset();
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
