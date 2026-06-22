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
	hasProjectTrustInputs,
	ModelRegistry,
	type SessionInfo as PiSessionInfo,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { v4 as uuidv4 } from "uuid";
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
 * Owns exactly one live pi AgentSessionRuntime.
 *
 * Sidebar rows are persisted pi sessions, not independently running agents.
 * Switching, creating and forking all replace the single active runtime through
 * AgentSessionRuntime, which is the SDK's supported lifecycle boundary.
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
	private runtime: AgentSessionRuntime | null = null;
	private runtimeUnsubscribe: (() => void) | null = null;
	private activeProjectId: string | null = null;
	private activeSessionId: string | null = null;
	private activeStatus: SessionStatus = "idle";
	private streamSequence = 0;
	private activeStreamId: string | null = null;
	private _mcpManager: McpManager | null = null;

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
				for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
					const info: ProjectInfo = { ...item, valid: existsSync(item.cwd) };
					this.projects.set(info.id, info);
				}
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
		if (this.runtime?.cwd === project.cwd) {
			this.runtime.services.settingsManager.setProjectTrusted(trusted);
			await this.runtime.session.reload();
		}
	}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		const existing = Array.from(this.projects.values()).find((project) => project.cwd === cwd);
		if (existing) {
			await this.setActiveProject(existing.id);
			return { project: existing, isDuplicate: true };
		}

		let finalName = name?.trim() || path.basename(cwd);
		const names = new Set(Array.from(this.projects.values()).map((project) => project.name));
		for (let suffix = 2; names.has(finalName); suffix++) finalName = `${name || path.basename(cwd)} (${suffix})`;
		const project: ProjectInfo = {
			id: uuidv4().slice(0, 8),
			name: finalName,
			cwd,
			createdAt: Date.now(),
			valid: existsSync(cwd),
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
		const sessions = project.valid ? await this.refreshProjectSessions(projectId) : [];
		if (sessions.length > 0 && !sessions.some((session) => session.id === this.activeSessionId)) {
			await this.activateSession(sessions[0].id);
			return;
		}
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId });
		this.emitSessionList(projectId);
	}

	async deleteProject(projectId: string): Promise<void> {
		const project = this.projects.get(projectId);
		if (!project) return;
		this.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: project.name,
			agentCount: (this.sessionsByProject.get(projectId) ?? []).length,
		});
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		const sessions = this.sessionsByProject.get(projectId) ?? [];
		if (this.activeSessionId && sessions.some((session) => session.id === this.activeSessionId)) {
			await this.disposeRuntime();
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
		if (this.activeProjectId === projectId) {
			this.activeProjectId = this.listProjects().find((project) => project.valid)?.id ?? null;
		}
		this.saveProjects();
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
		const isActive = session.id === this.activeSessionId && this.runtime !== null;
		const piSession = isActive ? this.runtime?.session : undefined;
		const stats = isActive ? piSession?.getSessionStats() : undefined;
		const model = piSession?.model;
		return {
			id: session.id,
			name: (session.name || session.firstMessage || "New chat").slice(0, MAX_NAME_LENGTH),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: (piSession?.thinkingLevel as ThinkingLevel | undefined) ?? "off",
			modelSupportsThinking: piSession?.supportsThinking() ?? false,
			availableThinkingLevels: (piSession?.getAvailableThinkingLevels() as ThinkingLevel[] | undefined) ?? ["off"],
			status: isActive ? this.activeStatus : "idle",
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

	listAgents(): AgentInfo[] {
		if (!this.activeProjectId) return [];
		return this.listAgentsInProject(this.activeProjectId);
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		return (this.sessionsByProject.get(projectId) ?? []).map((session) => this.sessionInfo(session));
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
		const session = this.findStoredSession(sessionId);
		return session ? this.sessionInfo(session) : undefined;
	}

	private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			await this.getMcpManager().connectAll();
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
					extensionFactories: [createMcpExtensionFactory(this.getMcpManager())],
				},
				resourceLoaderReloadOptions: {
					resolveProjectTrust: async () => trusted,
				},
			});
			const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
			return { ...result, services, diagnostics: services.diagnostics };
		};
	}

	private resolveProjectTrust(cwd: string): boolean {
		if (!hasProjectTrustInputs(cwd)) return true;
		const saved = this.trustStore.get(cwd);
		if (saved !== null) return saved;
		return this.globalSettingsManager.getDefaultProjectTrust() === "always";
	}

	private async createInitialRuntime(cwd: string, sessionManager: SessionManager): Promise<void> {
		await this.disposeRuntime();
		this.runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
			cwd,
			agentDir: getLookDir(),
			sessionManager,
		});
		this.runtime.setRebindSession(async (session) => this.bindSession(session));
		await this.bindSession(this.runtime.session);
	}

	private async bindSession(session: AgentSession): Promise<void> {
		this.runtimeUnsubscribe?.();
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		this.runtimeUnsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		this.activeSessionId = session.sessionId;
		this.activeStatus = "idle";
		this.emitRuntimeDiagnostics();
	}

	private emitRuntimeDiagnostics(): void {
		for (const diagnostic of this.runtime?.diagnostics ?? []) {
			if (diagnostic.type === "error" || diagnostic.type === "warning") {
				this.emit({ type: "error", agentId: this.activeSessionId ?? undefined, message: diagnostic.message });
			}
		}
		if (this.runtime?.modelFallbackMessage) {
			this.emit({
				type: "error",
				agentId: this.activeSessionId ?? undefined,
				message: this.runtime.modelFallbackMessage,
			});
		}
	}

	private async disposeRuntime(): Promise<void> {
		this.runtimeUnsubscribe?.();
		this.runtimeUnsubscribe = null;
		if (this.runtime) await this.runtime.dispose();
		this.runtime = null;
		this.activeSessionId = null;
		this.activeStatus = "idle";
		this.activeStreamId = null;
	}

	async activateSession(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.runtime) return;
		const stored = this.findStoredSession(sessionId);
		if (!stored) throw new Error(`Session ${sessionId} not found`);
		if (this.runtime) {
			const result = await this.runtime.switchSession(stored.path);
			if (result.cancelled) return;
		} else {
			await this.createInitialRuntime(stored.cwd, SessionManager.open(stored.path));
		}
		this.activeProjectId = stored.projectId;
		this.activeSessionId = this.runtime?.session.sessionId ?? sessionId;
		await this.refreshProjectSessions(stored.projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId: stored.projectId });
		this.emitSessionState();
	}

	async createAgent(opts?: { name?: string; projectId?: string } | string): Promise<string> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.activeProjectId;
		if (!projectId) throw new Error("No active project");
		const project = this.projects.get(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		if (this.runtime?.cwd === project.cwd) {
			const result = await this.runtime.newSession();
			if (result.cancelled) throw new Error("New session was cancelled by an extension");
		} else {
			await this.createInitialRuntime(project.cwd, SessionManager.create(project.cwd, getSessionsDir()));
		}
		const session = this.requireActiveSession();
		session.setSessionName((input.name?.trim() || "New chat").slice(0, MAX_NAME_LENGTH));
		this.activeProjectId = projectId;
		this.activeSessionId = session.sessionId;
		await this.refreshProjectSessions(projectId);
		this.emit({ type: "agent:created", agentId: session.sessionId, agent: this.getAgentInfo(session.sessionId)! });
		this.emitSessionState();
		return session.sessionId;
	}

	async destroyAgent(sessionId: string): Promise<void> {
		const stored = this.findStoredSession(sessionId);
		if (!stored) return;
		if (this.activeSessionId === sessionId) await this.disposeRuntime();
		try {
			fs.unlinkSync(stored.path);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		await this.refreshProjectSessions(stored.projectId);
		this.emit({ type: "agent:destroyed", agentId: sessionId });
		this.emitSessionList(stored.projectId);
	}

	getMessages(sessionId: string): PiMessage[] {
		const manager = this.sessionManagerFor(sessionId);
		return manager ? this.extractMessages(manager, sessionId) : [];
	}

	private sessionManagerFor(sessionId: string): SessionManager | null {
		if (this.activeSessionId === sessionId && this.runtime) return this.runtime.session.sessionManager;
		const stored = this.findStoredSession(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : null;
	}

	async sendMessage(sessionId: string, text: string): Promise<void> {
		await this.activateSession(sessionId);
		const session = this.requireActiveSession();
		await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
	}

	async abortAgent(sessionId: string): Promise<void> {
		if (this.activeSessionId !== sessionId || !this.runtime) return;
		await this.runtime.session.abort();
	}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		await this.activateSession(sessionId);
		const slash = modelKey.indexOf("/");
		if (slash <= 0) throw new Error(`Model key must be in provider/model form: ${modelKey}`);
		const model = this.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${modelKey}`);
		await this.requireActiveSession().setModel(model);
		this.emitActiveUpdated();
	}

	setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
		if (this.activeSessionId !== sessionId || !this.runtime)
			throw new Error("Select the session before changing thinking");
		this.runtime.session.setThinkingLevel(level);
	}

	getContextUsage(sessionId: string): ContextUsageInfo | undefined {
		if (this.activeSessionId !== sessionId || !this.runtime) return undefined;
		const usage = this.runtime.session.getContextUsage();
		if (!usage) return undefined;
		const percentage = usage.percent === null ? 0 : Math.min(100, Math.max(0, Math.round(usage.percent)));
		return {
			percentage,
			usedTokens: usage.tokens ?? 0,
			totalTokens: usage.contextWindow,
			level: percentage >= 80 ? "critical" : percentage >= 60 ? "warning" : "safe",
			compacting: this.runtime.session.isCompacting,
		};
	}

	async compressSession(sessionId: string): Promise<void> {
		await this.activateSession(sessionId);
		if (!this.requireActiveSession().isStreaming) await this.requireActiveSession().compact();
	}

	renameAgent(sessionId: string, name: string): void {
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		if (!trimmed) return;
		if (this.activeSessionId === sessionId && this.runtime) {
			this.runtime.session.setSessionName(trimmed);
		} else {
			const manager = this.sessionManagerFor(sessionId);
			manager?.appendSessionInfo(trimmed);
		}
		const stored = this.findStoredSession(sessionId);
		if (stored) stored.name = trimmed;
		this.emitActiveUpdated();
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
		if (this.activeSessionId !== sessionId || !this.runtime) return [];
		const session = this.runtime.session;
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
		await this.activateSession(sessionId);
		const session = this.requireActiveSession();
		const result = await session.navigateTree(entryId, opts);
		if (!result.cancelled) this.emitSessionState();
		return result;
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		await this.activateSession(sessionId);
		if (!this.runtime) throw new Error("No active session");
		const result = await this.runtime.fork(entryId, { position: "at" });
		if (result.cancelled) throw new Error("Fork was cancelled by an extension");
		const session = this.requireActiveSession();
		if (opts?.name?.trim()) session.setSessionName(opts.name.trim().slice(0, MAX_NAME_LENGTH));
		const projectId = this.activeProjectId;
		if (!projectId || !session.sessionFile) throw new Error("Forked session was not persisted");
		await this.refreshProjectSessions(projectId);
		this.emitSessionState();
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

	private requireActiveSession(): AgentSession {
		if (!this.runtime) throw new Error("No active session");
		return this.runtime.session;
	}

	private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		const rendererEvent = this.toRendererEvent(sessionId, event);
		if (rendererEvent) this.emit(rendererEvent);
		switch (event.type) {
			case "agent_start":
				this.updateActiveStatus("thinking");
				break;
			case "tool_execution_start":
				this.updateActiveStatus("working");
				break;
			case "agent_end":
				this.updateActiveStatus("idle");
				this.refreshAfterTurn(sessionId).catch((error) => this.emitError(error));
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
				this.emitActiveUpdated();
				break;
		}
	}

	private toRendererEvent(sessionId: string, event: AgentSessionEvent): MainToRendererEvent | null {
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			if (event.type === "message_start" || !this.activeStreamId) {
				this.activeStreamId = `stream:${sessionId}:${++this.streamSequence}`;
			}
			const rendererEvent = {
				...event,
				type: `agent:${event.type}`,
				agentId: sessionId,
				message: { ...event.message, id: this.activeStreamId },
			} as MainToRendererEvent;
			if (event.type === "message_end") this.activeStreamId = null;
			return rendererEvent;
		}
		return { ...event, type: `agent:${event.type}`, agentId: sessionId } as MainToRendererEvent;
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		if (!this.activeProjectId) return;
		await this.refreshProjectSessions(this.activeProjectId);
		this.emit({ type: "agent:history", agentId: sessionId, messages: this.getMessages(sessionId) });
		this.emitTree(sessionId);
		this.emitActiveUpdated();
		this.emitSessionList(this.activeProjectId);
	}

	private emitSessionState(): void {
		const sessionId = this.activeSessionId;
		if (!sessionId) return;
		this.emitSessionList(this.activeProjectId ?? "");
		this.emit({ type: "agent:history", agentId: sessionId, messages: this.getMessages(sessionId) });
		this.emitTree(sessionId);
		this.emitActiveUpdated();
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

	private updateActiveStatus(status: SessionStatus): void {
		this.activeStatus = status;
		if (this.activeSessionId) this.emit({ type: "agent:status", agentId: this.activeSessionId, status });
	}

	private emitActiveUpdated(): void {
		if (!this.activeSessionId) return;
		const info = this.getAgentInfo(this.activeSessionId);
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

	getGeneralSettings(): UserSettings {
		return this.userSettings.getAll();
	}

	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		const settings = await this.userSettings.update(partial);
		if (partial.compactionEnabled !== undefined && this.runtime) {
			this.runtime.session.setAutoCompactionEnabled(partial.compactionEnabled);
		}
		return settings;
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		return this.userSettings.reset();
	}

	listSkillsForUI() {
		const loaded = this.runtime?.services.resourceLoader.getSkills() ?? { skills: [], diagnostics: [] };
		return {
			skills: loaded.skills,
			diagnostics: loaded.diagnostics,
			importedPaths:
				this.runtime?.services.settingsManager.getSkillPaths() ?? this.globalSettingsManager.getSkillPaths(),
		};
	}

	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const settingsManager = this.runtime?.services.settingsManager ?? this.globalSettingsManager;
			const merged = Array.from(
				new Set(
					[...settingsManager.getSkillPaths(), ...paths]
						.map((item) => (item.startsWith("~") ? join(homedir(), item.slice(1)) : item))
						.filter((item) => existsSync(item)),
				),
			);
			settingsManager.setSkillPaths(merged);
			await settingsManager.flush();
			if (this.runtime) await this.runtime.session.reload();
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

	private emitError(error: unknown): void {
		this.emit({
			type: "error",
			agentId: this.activeSessionId ?? undefined,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
