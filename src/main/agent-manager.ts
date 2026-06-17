// ============================================================
// AgentManager — Agent Runtime Core
//
// Persistence: pi SessionManager manages session .jsonl files natively
// (create/open/auto-save). We only store a lightweight agents.json index
// mapping agentId → sessionFile.
// ============================================================

import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { v4 as uuidv4 } from "uuid";
import { getRoleDefaults, getRoleSystemPrompt, getRoleTools, normalizeAgentRole } from "./agents/roles.js";
import { createMcpExtensionFactory, toolPiName } from "./mcp/mcp-extension.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { migrateLegacySettings } from "./migrate-settings.js";
import { PermissionAskService } from "./permissions/permission-ask.js";
import { checkPermission } from "./permissions/permission-gate.js";
import {
	ensureLookDir,
	getAgentsIndexPath,
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
	AgentStatus,
	ContextUsageInfo,
	ForkedSessionResult,
	MainToRendererEvent,
	NavigateTreeResult,
	PermissionMode,
	PiMessage,
	PiToolCallBlock,
	ProjectInfo,
	SessionForkPoint,
	SessionTreeNode,
	ThinkingLevel,
	UsageSnapshot,
} from "./shared/types.js";
import {
	findSkill,
	formatInvocation,
	gatherSkillPaths,
	invalidateSkillCache,
	type LoadedSkills,
	listAllSkills,
} from "./skills/skill-loader.js";
import { type UserSettings, UserSettingsStore } from "./user-settings.js";

/** Tools allowed in "plan" mode. Anything else is hard-blocked. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Names of pi's built-in coding-agent tools (the default 7). */
const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

/** Filter a role's tool list down to pi's built-in tool names. */
function resolveToolNames(roleToolNames: string[] | null): string[] {
	const builtins = new Set(BUILTIN_TOOL_NAMES);
	return (roleToolNames ?? [...BUILTIN_TOOL_NAMES]).filter((t) => builtins.has(t));
}

// ============================================================
// Types
// ============================================================

interface ManagedAgent {
	info: AgentInfo;
	session: AgentSession;
	messages: PiMessage[];
	unsubscribe: () => void;
	/** Per-agent permission mode (ask / plan / allow). */
	permissionMode: PermissionMode;
	/**
	 * Mirror of `session.sessionManager.getLeafId()`. Updated from the
	 * SDK's `message_start` event (which is when the leaf actually
	 * advances — `appendMessage` is internal to pi). Persisted into
	 * `agents.json` so a restart lands on the same branch the user
	 * was on. See `syncLeafFromSession` for the sync point.
	 */
	leafId: string | null;
}

interface ManagedProject {
	info: ProjectInfo;
	settingsManager: SettingsManager;
	userSettings: UserSettingsStore;
}

export type EventCallback = (event: MainToRendererEvent) => void;

/** 从 pi SDK 消息中提取纯文本内容 */
function extractTextFromPiMessage(msg: any): string {
	if (typeof msg.content === "string") return msg.content.trim();
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n")
			.trim();
	}
	return "";
}

/** 从 pi SDK assistant message 中提取纯文本内容 */
function extractTextFromAssistantMessage(msg: any): string {
	if (!Array.isArray(msg?.content)) return "";
	return msg.content
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text ?? "")
		.join("\n")
		.trim();
}

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

function cloneUsageSnapshot(usage: Partial<UsageSnapshot> | null | undefined): UsageSnapshot {
	const cost = usage?.cost;
	return {
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
		cost: {
			input: cost?.input ?? 0,
			output: cost?.output ?? 0,
			cacheRead: cost?.cacheRead ?? 0,
			cacheWrite: cost?.cacheWrite ?? 0,
			total: cost?.total ?? 0,
		},
	};
}

/** 默认 Chat Agent 名称 — 标题为此名称的会话在首次回复后自动生成标题 */
const DEFAULT_CHAT_NAME = "聊天助手";

/** 标题生成 Prompt */
const TITLE_PROMPT =
	"根据用户的第一条消息，总结用户在问什么或者想要解决什么问题，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。如果消息内容过短或无明确主题，直接使用原始消息作为标题。\n\n用户消息：";

/** 短消息阈值：低于此长度直接使用原文作为标题 */
const SHORT_MESSAGE_THRESHOLD = 4;

/** 最大标题长度 */
const MAX_TITLE_LENGTH = 20;

/** Cap on agent display name length. Mirrors pi's own sanity cap
 *  so fork-names fit in the sidebar without truncating at render. */
const MAX_NAME_LEN = 80;

// ============================================================
// AgentManager
// ============================================================

export class AgentManager {
	private agents = new Map<string, ManagedAgent>();
	private projects = new Map<string, ManagedProject>();
	private activeProjectId: string | null = null;
	private eventCallbacks: EventCallback[] = [];
	private permissionAsk = new PermissionAskService((event) => this.emit(event));
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;

	private agentUsage = new Map<string, UsageSnapshot>();
	private lastContextTokens = new Map<string, number>();
	private firstUserMessage = new Map<string, string>();
	private titleInFlight = new Set<string>();
	private messageUpdateBuffers = new Map<string, any>();
	private messageUpdateFlushTimer: NodeJS.Timeout | null = null;
	private agentsIndexPath: string;
	private projectsIndexPath: string;
	private _mcpManager: McpManager | null = null;

	constructor() {
		ensureLookDir();

		// One-shot legacy settings migration: rewrites the old
		// UserSettingsStore field names to the new SDK-backed
		// schema. Runs *before* `SettingsManager.create()` so the
		// SDK reads the post-migration file directly — no reload
		// dance, no transient state where the store sees the old
		// shape. Stamps `_migrated: true` so this is a no-op from
		// the second boot onwards.
		const migration = migrateLegacySettings();
		if (migration.migrated && migration.keys.length > 0) {
			console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
		}

		this.authStorage = AuthStorage.create(getAuthPath());
		this.modelRegistry = ModelRegistry.create(this.authStorage, getModelsPath());
		this.agentsIndexPath = getAgentsIndexPath();
		this.projectsIndexPath = getProjectsIndexPath();
	}

	getMcpManager(): McpManager {
		if (!this._mcpManager) {
			this._mcpManager = new McpManager();
			// When MCP tools change, update all active sessions.
			this._mcpManager.on("tools:changed", () => {
				for (const [, m] of this.agents) {
					this.syncMcpToolsIntoSession(m.session);
				}
			});
		}
		return this._mcpManager;
	}

	/**
	 * Ensure MCP tools are in the session's active tool list.
	 * pi SDK filters extension tools out when `tools` is passed
	 * to createAgentSession (our role-based filtering), so we
	 * must explicitly add MCP tool names after creation.
	 */
	private syncMcpToolsIntoSession(session: any): void {
		try {
			const mcpTools = this.getMcpManager().listAllTools();
			if (mcpTools.length === 0) return;
			const mcpToolNames = mcpTools.map((t) => toolPiName(t.serverName, t.name));
			const currentTools: string[] = session.getActiveToolNames() ?? [];
			const merged = [...new Set([...currentTools, ...mcpToolNames])];
			session.setActiveToolsByName(merged);
		} catch {
			// Session might not be ready yet — harmless.
		}
	}

	// ============================================================
	// Project management
	// ============================================================

	/** Load projects from ~/.look/projects.json. Validates cwd existence. */
	async loadProjects(): Promise<ProjectInfo[]> {
		try {
			if (fs.existsSync(this.projectsIndexPath)) {
				const raw = JSON.parse(fs.readFileSync(this.projectsIndexPath, "utf-8"));
				const items: ProjectInfo[] = raw.projects ?? [];
				for (const p of items) {
					p.valid = fs.existsSync(p.cwd);
					if (p.valid) {
						const sm = SettingsManager.create(p.cwd, getLookDir());
						const us = new UserSettingsStore(sm, getUiSettingsPath());
						this.projects.set(p.id, { info: p, settingsManager: sm, userSettings: us });
					} else {
						// Still add invalid projects so they appear greyed out in UI
						const sm = SettingsManager.create(process.cwd(), getLookDir());
						const us = new UserSettingsStore(sm, getUiSettingsPath());
						this.projects.set(p.id, { info: p, settingsManager: sm, userSettings: us });
					}
				}
				return items;
			}
		} catch (err) {
			console.error("[Look] Failed to load projects:", err);
		}
		return [];
	}

	private saveProjects(): void {
		try {
			const data = {
				projects: Array.from(this.projects.values()).map((mp) => ({
					id: mp.info.id,
					name: mp.info.name,
					cwd: mp.info.cwd,
					createdAt: mp.info.createdAt,
				})),
			};
			const tmp = `${this.projectsIndexPath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
			fs.renameSync(tmp, this.projectsIndexPath);
		} catch (err) {
			console.error("[Look] Failed to persist projects:", err);
		}
	}

	/** Create a new project. Checks for duplicate cwd, auto-deduplicates names. */
	createProject(cwd: string, name?: string): { project: ProjectInfo; isDuplicate: boolean } {
		// Guard: duplicate cwd
		for (const [, mp] of this.projects) {
			if (mp.info.cwd === cwd) {
				// Switch to existing project
				this.setActiveProject(mp.info.id);
				return { project: mp.info, isDuplicate: true };
			}
		}

		let finalName = name ?? path.basename(cwd);
		// Auto-deduplicate names
		const existingNames = new Set(Array.from(this.projects.values()).map((mp) => mp.info.name));
		if (existingNames.has(finalName)) {
			let n = 2;
			while (existingNames.has(`${finalName} (${n})`)) {
				n++;
			}
			finalName = `${finalName} (${n})`;
		}

		const id = uuidv4().slice(0, 8);
		const info: ProjectInfo = {
			id,
			name: finalName,
			cwd,
			createdAt: Date.now(),
			valid: fs.existsSync(cwd),
		};

		// For new projects, inherit global settings as baseline
		// Use a global SettingsManager to copy defaults, then create per-project one
		const sm = SettingsManager.create(cwd, getLookDir());
		const us = new UserSettingsStore(sm, getUiSettingsPath());
		// Copy global defaults into project settings
		const globalDefaults = new UserSettingsStore(
			SettingsManager.create(process.cwd(), getLookDir()),
			getUiSettingsPath(),
		);
		const globalAll = globalDefaults.getAll();
		us.update({
			defaultThinkingLevel: globalAll.defaultThinkingLevel,
			preferredModel: globalAll.preferredModel,
			autoCollapse: globalAll.autoCollapse,
			compactionEnabled: globalAll.compactionEnabled,

			chatSystemPrompt: globalAll.chatSystemPrompt,
		});

		this.projects.set(id, { info, settingsManager: sm, userSettings: us });
		this.saveProjects();
		this.setActiveProject(id);
		return { project: info, isDuplicate: false };
	}

	/** Switch the active project. Emits filtered agent list + history to renderer. */
	setActiveProject(projectId: string): void {
		const mp = this.projects.get(projectId);
		if (!mp) {
			console.warn(`[Look] setActiveProject: project ${projectId} not found`);
			return;
		}
		this.activeProjectId = projectId;
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId });
		this.emitAgentList();
		// Push history for agents in this project
		for (const [id, m] of this.agents) {
			if (m.info.projectId === projectId) {
				this.emit({ type: "agent:history", agentId: id, messages: m.messages });
			}
		}
	}

	/** Delete a project and all its agents. Requires UI confirmation via IPC. */
	async deleteProject(projectId: string): Promise<void> {
		const mp = this.projects.get(projectId);
		if (!mp) return;

		// Count agents for confirmation dialog
		const projectAgents = Array.from(this.agents.entries()).filter(([, m]) => m.info.projectId === projectId);

		// Send confirmation request to renderer
		this.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: mp.info.name,
			agentCount: projectAgents.length,
		});
		// The actual deletion happens when renderer responds via project:confirm-delete-response
	}

	/** Execute project deletion after user confirmation. */
	async executeDeleteProject(projectId: string): Promise<void> {
		// Destroy all agents in this project
		const agentIds = Array.from(this.agents.entries())
			.filter(([, m]) => m.info.projectId === projectId)
			.map(([id]) => id);
		for (const agentId of agentIds) {
			await this.destroyAgent(agentId);
		}

		this.projects.delete(projectId);
		if (this.activeProjectId === projectId) {
			this.activeProjectId = null;
			// Try to switch to first valid project
			const firstValid = Array.from(this.projects.values()).find((mp) => mp.info.valid);
			if (firstValid) {
				this.activeProjectId = firstValid.info.id;
			}
		}
		this.saveProjects();
		this.emitProjectList();
		if (this.activeProjectId) {
			this.emitAgentList();
		}
	}

	/** Migrate legacy agents (no projectId) to projects. One-shot backward compat. */
	private migrateLegacyAgents(): void {
		const orphans = Array.from(this.agents.entries()).filter(([, m]) => !m.info.projectId);
		if (orphans.length === 0) return;

		console.log(`[Look] Migrating ${orphans.length} legacy agents to projects...`);

		// Group by cwd (read from session header)
		const cwdGroups = new Map<string, Array<[string, ManagedAgent]>>();
		for (const [id, m] of orphans) {
			const sessionFile = m.session.sessionFile;
			let agentCwd = process.cwd(); // fallback
			if (sessionFile && fs.existsSync(sessionFile)) {
				try {
					const content = fs.readFileSync(sessionFile, "utf-8");
					const lines = content.trim().split("\n");
					if (lines.length > 0) {
						const header = JSON.parse(lines[0]);
						if (header.cwd) agentCwd = header.cwd;
					}
				} catch {
					// Keep fallback cwd
				}
			}
			const group = cwdGroups.get(agentCwd) ?? [];
			group.push([id, m]);
			cwdGroups.set(agentCwd, group);
		}

		// Create project for each cwd group
		for (const [cwd, agentPairs] of cwdGroups) {
			const folderName = path.basename(cwd);
			const result = this.createProject(cwd, `Imported: ${folderName}`);
			if (result.isDuplicate) {
				// Project already exists from a previous migration step
			}
			const projectId = result.project.id;
			for (const [_id, m] of agentPairs) {
				m.info.projectId = projectId;
			}
		}

		this.saveIndex();
		this.saveProjects();
	}

	// ---- Project accessors ----

	getActiveProject(): ProjectInfo | null {
		if (!this.activeProjectId) return null;
		return this.projects.get(this.activeProjectId)?.info ?? null;
	}

	getActiveProjectCwd(): string {
		const project = this.getActiveProject();
		if (!project) throw new Error("No active project. Select a project folder first.");
		if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		return project.cwd;
	}

	getAgentCwd(agentId: string): string {
		const m = this.agents.get(agentId);
		if (!m) return process.cwd();
		if (m.info.projectId) {
			const mp = this.projects.get(m.info.projectId);
			if (mp?.info.valid) return mp.info.cwd;
		}
		return m.session.sessionManager.getCwd?.() ?? process.cwd();
	}

	getProjectSettings(projectId?: string): UserSettingsStore | null {
		const pid = projectId ?? this.activeProjectId;
		if (!pid) return null;
		return this.projects.get(pid)?.userSettings ?? null;
	}

	private resolveProjectCwd(projectId: string | undefined, fallback: string): string {
		if (!projectId) return fallback;
		const mp = this.projects.get(projectId);
		return mp?.info.valid ? mp.info.cwd : fallback;
	}

	private settingsManagerForCwd(cwd: string, projectId?: string): SettingsManager {
		if (projectId) {
			const mp = this.projects.get(projectId);
			if (mp?.info.valid && mp.info.cwd === cwd) return mp.settingsManager;
		}
		for (const mp of this.projects.values()) {
			if (mp.info.valid && mp.info.cwd === cwd) return mp.settingsManager;
		}
		return SettingsManager.create(cwd, getLookDir());
	}

	private restorePersistedLeaf(sm: SessionManager, leafId: unknown, agentId: string): string | null {
		if (leafId === undefined) return sm.getLeafId();
		try {
			if (leafId === null) {
				sm.resetLeaf();
			} else if (typeof leafId === "string" && leafId !== sm.getLeafId()) {
				sm.branch(leafId);
			}
		} catch (err) {
			console.warn(`[Look] Failed to restore leaf ${String(leafId)} for agent ${agentId}:`, err);
		}
		return sm.getLeafId();
	}

	listProjects(): ProjectInfo[] {
		const all = Array.from(this.projects.values()).map((mp) => mp.info);
		// Sort: valid first, then by name
		all.sort((a, b) => {
			if (a.valid !== b.valid) return a.valid ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return all;
	}

	private emitProjectList(): void {
		this.emit({ type: "project:list", projects: this.listProjects(), activeProjectId: this.activeProjectId });
	}

	/** Must be called after construction (async). Restores agents from ~/.look/. */
	async restoreWorkspace(): Promise<number> {
		return this.loadPersistedAgents();
	}

	// ============================================================
	// Persistence — pi SessionManager handles sessions natively.
	// We only store: agents.json → [{ id, name, role, sessionFile }]
	// ============================================================

	/** Save lightweight index to ~/.look/agents.json */
	private saveIndex(): void {
		try {
			const data = {
				agents: Array.from(this.agents.entries()).map(([id, m]) => ({
					id,
					name: m.info.name,
					role: m.info.role,
					model: m.info.model,
					thinkingLevel: m.info.thinkingLevel,
					modelSupportsThinking: m.info.modelSupportsThinking,
					availableThinkingLevels: m.info.availableThinkingLevels,
					sessionFile: m.session.sessionFile ?? undefined,
					// v0.4: persist the active leaf so a restart lands on
					// the same branch the user was on (otherwise pi's
					// default leaf = last append = end of file, which
					// looks like the branch switch never happened).
					leafId: m.leafId,
					permissionMode: m.permissionMode,
					usage: m.info.usage,
					createdAt: m.info.createdAt,
					projectId: m.info.projectId,
				})),
			};
			const tmp = `${this.agentsIndexPath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
			fs.renameSync(tmp, this.agentsIndexPath);
		} catch (err) {
			console.error("[Look] Failed to persist agent index:", err);
		}
	}

	/**
	 * Load agents from ~/.look/ on restart.
	 *
	 * 1. Read agents.json → get sessionFile for each agent
	 * 2. SessionManager.open(sessionFile) → pi loads the session
	 * 3. sm.getEntries() → extract message entries
	 * 4. convertPiMessage() → UI format
	 * 5. createAgentSession({ sessionManager }) → live pi session
	 */
	private async loadPersistedAgents(): Promise<number> {
		try {
			if (!fs.existsSync(this.agentsIndexPath)) return 0;
			const data = JSON.parse(fs.readFileSync(this.agentsIndexPath, "utf-8"));
			if (!Array.isArray(data.agents)) return 0;

			let loaded = 0;
			for (const entry of data.agents) {
				const id = entry.id;
				const sessionFile = entry.sessionFile;
				if (!sessionFile || !fs.existsSync(sessionFile)) continue;
				if (this.agents.has(id)) continue;

				// Open pi session from existing file. Apply the persisted
				// leaf immediately, before extracting UI history or creating
				// AgentSession, so the SDK context and Look's mirror both point
				// at the same branch.
				const sm = SessionManager.open(sessionFile);
				this.restorePersistedLeaf(sm, entry.leafId, id);
				const sessionCwd = sm.getCwd?.() ?? process.cwd();
				const projectCwd = this.resolveProjectCwd(entry.projectId, sessionCwd);

				const uiMessages = this.extractMessagesFromSessionManager(sm, id);

				// Backfill toolCall blocks with toolResult isError/result
				for (const tmsg of uiMessages) {
					if (tmsg.role !== "tool") continue;
					const tcId = (tmsg as any)._toolCallId as string | undefined;
					const isErr = (tmsg as any)._isError as boolean | undefined;
					if (!tcId) continue;
					for (const am of uiMessages) {
						if (am.role !== "assistant") continue;
						const block = am.contentBlocks.find(
							(b) => b.type === "toolCall" && (b as PiToolCallBlock).id === tcId,
						) as PiToolCallBlock | undefined;
						if (!block) continue;
						block.result =
							(tmsg as any).contentBlocks
								?.filter((bb: any) => bb.type === "text")
								.map((bb: any) => bb.text ?? "")
								.join("\n") ?? "";
						block.isError = isErr ?? false;
						block.status = isErr ? "error" : "success";
						break;
					}
				}

				// Recalculate cumulative token usage from persisted messages.
				// pi SDK persists usage per-message in the JSONL session file,
				// so we reconstruct the agent-level total by walking all
				// assistant messages. This is the source of truth — entry.usage
				// (if present) is only used as a fallback for agents whose
				// messages happen to carry no usage data.
				let cumUsage: UsageSnapshot = emptyUsageSnapshot();
				let hasMessageUsage = false;
				for (const msg of uiMessages) {
					if (msg.role !== "assistant" || !msg.usage) continue;
					hasMessageUsage = true;
					const u = msg.usage;
					cumUsage.inputTokens += u.inputTokens;
					cumUsage.outputTokens += u.outputTokens;
					cumUsage.cacheReadTokens += u.cacheReadTokens;
					cumUsage.cacheWriteTokens += u.cacheWriteTokens;
					cumUsage.totalTokens += u.totalTokens;
					cumUsage.cost.input += u.cost.input;
					cumUsage.cost.output += u.cost.output;
					cumUsage.cost.cacheRead += u.cost.cacheRead;
					cumUsage.cost.cacheWrite += u.cost.cacheWrite;
					cumUsage.cost.total += u.cost.total;
				}
				// Fallback: if no message had usage (e.g. very old sessions),
				// use whatever was in the index file.
				if (!hasMessageUsage && entry.usage) {
					cumUsage = cloneUsageSnapshot(entry.usage);
				}

				// Restore last-context-tokens from the last assistant message.
				// This seeds the context ring so it shows the correct usage
				// immediately on restart, rather than showing 0% until the
				// next message_end arrives.
				const lastAssistantWithUsage = [...uiMessages].reverse().find((m) => m.role === "assistant" && m.usage);
				if (lastAssistantWithUsage?.usage) {
					this.lastContextTokens.set(id, lastAssistantWithUsage.usage.inputTokens);
				}

				// Build agent info. Model/thinking capabilities are intentionally
				// left as best-effort initial values here; the authoritative values
				// come from AgentSession after createAgentSession() below.
				const role = normalizeAgentRole(entry.role);
				const info: AgentInfo = {
					id,
					name: entry.name ?? "Agent",
					role,
					model: entry.model ?? "",
					thinkingLevel: entry.thinkingLevel ?? "medium",
					modelSupportsThinking: entry.modelSupportsThinking ?? false,
					status: "idle",
					messageCount: uiMessages.length,
					createdAt: entry.createdAt ?? Date.now(),
					usage: cloneUsageSnapshot(cumUsage),
					permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
					projectId: entry.projectId,
				};

				// Rebuild live pi session from the opened session file.
				// Keep cwd/settings/resource loader aligned the way the SDK's
				// createAgentSession() default path does.
				const settingsManager = this.settingsManagerForCwd(projectCwd, entry.projectId);

				const roleToolNames = getRoleTools(info.role); // string[] | null
				let systemPrompt = getRoleSystemPrompt(info.role);
				if (info.role === "chat") {
					const custom = this.getProjectSettings(info.projectId)?.getAll().chatSystemPrompt;
					if (custom) systemPrompt = custom;
				}
				const resourceLoader = this.buildResourceLoader({
					systemPrompt,
					agentId: id,
					cwd: projectCwd,
					settingsManager,
				});
				await resourceLoader.reload();

				const allToolNames = resolveToolNames(roleToolNames);

				// Let the SDK restore the session using the model/thinking level
				// recorded in the session file or from SettingsManager defaults.
				// Do not pin a Look-derived model here; AgentSession.model is the
				// source of truth after creation.
				const { session } = await createAgentSession({
					cwd: projectCwd,
					authStorage: this.authStorage,
					modelRegistry: this.modelRegistry,
					sessionManager: sm,
					settingsManager,
					tools: allToolNames,
					resourceLoader,
				});
				// Mirror the SDK's effective model and thinking state back into
				// Look's AgentInfo. This is the authoritative source.
				const effectiveModel = session.model;
				if (effectiveModel) {
					info.model = `${effectiveModel.provider}/${effectiveModel.id}`;
					info.modelSupportsThinking = effectiveModel.reasoning ?? false;
				}
				info.thinkingLevel = session.thinkingLevel;
				info.availableThinkingLevels = session.getAvailableThinkingLevels() ?? entry.availableThinkingLevels;

				this.syncMcpToolsIntoSession(session);

				const managed: ManagedAgent = {
					info,
					session,
					messages: uiMessages,
					unsubscribe: session.subscribe((event) => this.handleSessionEvent(id, event)),
					permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
					leafId: sm.getLeafId(),
				};

				this.agents.set(id, managed);
				this.agentUsage.set(id, cloneUsageSnapshot(cumUsage));
				loaded++;
			}

			if (loaded > 0) {
				console.log(`[Look] Restored ${loaded} agent(s) from ~/.look/`);
				this.saveIndex();
				this.emitAgentList();
			}
			// Run one-shot legacy migration for agents without projectId
			this.migrateLegacyAgents();
			return loaded;
		} catch (err) {
			console.error("[Look] Failed to load agents:", err);
			return 0;
		}
	}

	// ============================================================
	// Provider & Model
	// ============================================================

	setApiKey(provider: string, key: string): void {
		const trimmed = key?.trim() ?? "";
		if (!trimmed) {
			this.authStorage.remove(provider);
		} else {
			this.authStorage.set(provider, { type: "api_key", key: trimmed });
		}
	}

	/** Retrieve a stored API key for the given provider (or undefined if not stored). */
	getApiKey(provider: string): string | undefined {
		const cred = this.authStorage.get(provider);
		if (cred?.type === "api_key") return cred.key;
		return undefined;
	}

	/**
	 * Self-test a candidate API key against the provider's own endpoint.
	 * Thin wrapper over `provider-validator` so IPC stays uniform.
	 */
	async testApiKey(provider: string, key: string) {
		const { testApiKey } = await import("./provider-validator.js");
		return testApiKey(provider, key);
	}

	/**
	 * Self-test the SDK-configured credential for a provider. This covers
	 * environment, OAuth, and models.json auth without Look reading provider
	 * config directly.
	 */
	async testEnvKey(provider: string) {
		const { testConfiguredProvider } = await import("./provider-validator.js");
		return testConfiguredProvider(this.modelRegistry, provider);
	}

	/** Return provider IDs whose SDK auth source is the environment. */

	private isUserConfigured(provider: string): boolean {
		return this.authStorage.has(provider);
	}

	/** Returns the active project's root directory path. */
	getProjectRoot(): string {
		return this.getActiveProjectCwd();
	}

	/**
	 * Synchronous accessor for the user-configured model set. Used by
	 * the createAgent path (which is async but wants to derive the
	 * first-available model before yielding to the modelRegistry).
	 */
	getAvailableModelsSync(): Array<{
		provider: string;
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
		cost: { input: number; output: number };
	}> {
		return this.modelRegistry
			.getAvailable()
			.filter((m) => this.authStorage.has(m.provider))
			.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 16384,
				cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
			}));
	}

	async getAvailableModels(): Promise<
		Array<{
			provider: string;
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
			cost: { input: number; output: number };
		}>
	> {
		return this.getAvailableModelsSync();
	}

	async getProviders(): Promise<Array<{ id: string; name: string; hasCredentials: boolean; models: string[] }>> {
		const allModels = this.modelRegistry.getAll();
		const providerMap = new Map<string, { name: string; models: string[] }>();
		for (const m of allModels) {
			const e = providerMap.get(m.provider);
			if (e) {
				e.models.push(m.id);
			} else {
				providerMap.set(m.provider, {
					name: this.modelRegistry.getProviderDisplayName(m.provider),
					models: [m.id],
				});
			}
		}
		return Array.from(providerMap.entries()).map(([id, info]) => ({
			id,
			name: info.name,
			hasCredentials: this.isUserConfigured(id),
			models: this.isUserConfigured(id) ? info.models : [],
		}));
	}

	async getProviderSettings() {
		const providers = await this.getProviders();
		const availableByProvider = new Map<
			string,
			Array<{
				id: string;
				name: string;
				reasoning: boolean;
				contextWindow: number;
				maxTokens: number;
			}>
		>();
		for (const m of this.getAvailableModelsSync()) {
			const models = availableByProvider.get(m.provider) ?? [];
			models.push({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 16384,
			});
			availableByProvider.set(m.provider, models);
		}
		return providers.map((p) => {
			const s = this.modelRegistry.getProviderAuthStatus(p.id);
			const models = availableByProvider.get(p.id) ?? [];
			return {
				id: p.id,
				name: p.name,
				hasKey: p.hasCredentials,
				envVar: s.source === "environment" ? s.label : undefined,
				modelsAvailable: models.length,
				models,
				authSource: s.source,
				envLabel: s.label,
			};
		});
	}

	getGeneralSettings(): UserSettings {
		return (
			this.getProjectSettings() ??
			new UserSettingsStore(SettingsManager.create(process.cwd(), getLookDir()), getUiSettingsPath())
		).getAll();
	}
	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		return (
			this.getProjectSettings() ??
			new UserSettingsStore(SettingsManager.create(process.cwd(), getLookDir()), getUiSettingsPath())
		).update(partial);
	}
	async resetGeneralSettings(): Promise<UserSettings> {
		return (
			this.getProjectSettings() ??
			new UserSettingsStore(SettingsManager.create(process.cwd(), getLookDir()), getUiSettingsPath())
		).reset();
	}

	// ============================================================
	// v0.3 Skills — IPC surface
	//
	// These four methods back the renderer-side `/skill:name` slash
	// menu and the "Import from Claude/Cursor/Codex/Copilot" affordance.
	// Skill *loading* and *system-prompt injection* are handled by the
	// pi SDK (DefaultResourceLoader + buildSystemPrompt) — Look just
	// exposes the metadata + the write paths.
	// ============================================================

	/**
	 * Snapshot of all skills visible to this project for the renderer
	 * to render in the slash menu. Combines:
	 *   - Look's project + global skills (`~/.look/skills/`,
	 *     `<root>/.look/skills/`)
	 *   - User-imported paths from `settings.json.skills`
	 *   - Diagnostics (validation warnings, name collisions)
	 */
	listSkillsForUI(): {
		skills: LoadedSkills["skills"];
		diagnostics: LoadedSkills["diagnostics"];
		importedPaths: string[];
	} {
		const loaded = listAllSkills(this.getActiveProjectCwd());
		return {
			skills: loaded.skills,
			diagnostics: loaded.diagnostics,
			importedPaths: this.readImportedSkillPaths(),
		};
	}

	/**
	 * Trigger a skill on a worker agent. Builds a `/skill:name <args>`
	 * prompt via the pi-agent-core `formatSkillInvocation` helper and
	 * sends it as a normal user message. The worker follows the skill
	 * instructions on its next turn.
	 */
	async invokeSkill(agentId: string, skillName: string, args?: string): Promise<{ success: boolean; error?: string }> {
		const skill = findSkill(this.getActiveProjectCwd(), skillName);
		if (!skill) {
			return { success: false, error: `Skill "${skillName}" not found` };
		}
		if (skill.disableModelInvocation) {
			return { success: false, error: `Skill "${skillName}" is hidden from the worker; cannot invoke via /skill:` };
		}
		const prompt = formatInvocation(skill, args);
		await this.sendMessage(agentId, prompt);
		return { success: true };
	}

	/**
	 * Add one or more `skillPaths` to the SDK-managed global skills list.
	 * Used by the renderer's "Import from <tool>" affordance to make
	 * Claude Code / Cursor / Codex / Copilot skills available in Look.
	 */
	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const cwd = this.getActiveProject()?.cwd ?? process.cwd();
			const settingsManager = SettingsManager.create(cwd, getLookDir());
			const existing = settingsManager.getSkillPaths();
			// De-dup (preserve order, prefer earliest). Expand `~` and
			// drop non-existent paths so we don't pollute the file.
			const seen = new Set<string>();
			const merged: string[] = [];
			for (const p of [...existing, ...paths]) {
				if (typeof p !== "string") continue;
				const expanded = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
				if (!existsSync(expanded)) continue;
				if (seen.has(expanded)) continue;
				seen.add(expanded);
				merged.push(expanded);
			}
			settingsManager.setSkillPaths(merged);
			await settingsManager.flush();
			invalidateSkillCache();
			return { success: true, importedCount: merged.length };
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			return { success: false, importedCount: 0, error: msg };
		}
	}

	/**
	 * Scan well-known third-party skill directories (Claude Code,
	 * Cursor, OpenAI Codex, GitHub Copilot) and report which exist.
	 * Renderer uses this to render the "Import from ..." chips in
	 * the slash menu. We only check — never auto-import.
	 */
	detectCommonSkillPaths(): Array<{ tool: string; path: string; exists: boolean; skillCount: number }> {
		const home = homedir();
		const candidates: Array<{ tool: string; dir: string }> = [
			{ tool: "Claude Code", dir: join(home, ".claude", "skills") },
			{ tool: "Cursor", dir: join(home, ".cursor", "skills") },
			{ tool: "OpenAI Codex", dir: join(home, ".codex", "skills") },
			{ tool: "GitHub Copilot", dir: join(home, ".config", "github-copilot", "skills") },
			{ tool: "Hermes Agent", dir: join(home, ".hermes", "skills") },
			{ tool: "pi SDK", dir: join(home, ".pi", "skills") },
		];
		return candidates.map((c) => {
			const exists = existsSync(c.dir);
			let skillCount = 0;
			if (exists) {
				try {
					// Shallow count of immediate child dirs containing SKILL.md
					skillCount = fs
						.readdirSync(c.dir, { withFileTypes: true })
						.filter((e) => e.isDirectory() && existsSync(join(c.dir, e.name, "SKILL.md"))).length;
				} catch {
					skillCount = 0;
				}
			}
			return { tool: c.tool, path: c.dir, exists, skillCount };
		});
	}

	// Internal: read the SDK-managed merged skills array for the
	// `listSkillsForUI` snapshot.
	private readImportedSkillPaths(): string[] {
		try {
			const cwd = this.getActiveProject()?.cwd ?? process.cwd();
			return SettingsManager.create(cwd, getLookDir()).getSkillPaths();
		} catch {
			return [];
		}
	}

	// ============================================================
	// Model Resolution
	// ============================================================

	/**
	 * Walk the candidate list (primary + fallbacks) and return the
	 * first entry whose provider is BOTH registered in the model
	 * registry AND has an API key configured by the user.
	 *
	 * Pure-lookup (registry-only) is not enough: a model entry may
	 * exist for an unconfigured provider, and picking it would
	 * cause createAgentSession to crash deep in pi internals on
	 * the auth lookup. The auth check here produces a clean,
	 * user-friendly error chain.
	 */
	private lookupModel(provider: string, modelId: string) {
		return this.modelRegistry.find(provider, modelId);
	}

	// ============================================================
	// Context Usage & Compression
	// ============================================================

	getContextUsage(agentId: string): ContextUsageInfo | undefined {
		const m = this.agents.get(agentId);
		if (!m) return undefined;
		let cw = 128000;

		// Context window from the model registry.
		// Custom entries in ~/.look/models.json can override built-in
		// models; if they omit `reasoning` / `thinkingLevelMap`, the
		// model will appear as non-reasoning even if the built-in entry
		// supports thinking.
		const ms = m.info.model;
		if (ms) {
			const [p, ...parts] = ms.includes("/") ? ms.split("/") : ["anthropic", ms];
			const mdl = this.lookupModel(p, parts.join("/"));
			if (mdl?.contextWindow) cw = mdl.contextWindow;
		}

		// Use the input tokens from the most recent assistant response.
		// Each request sends the full conversation history, so input
		// tokens reflect the current context size.  Fall back to
		// cumulative totalTokens when per-message input is empty
		// (e.g. after restore from disk on a fresh agent).
		let used = this.lastContextTokens.get(agentId) ?? 0;
		if (used === 0) {
			const cum = this.agentUsage.get(agentId);
			if (cum && cum.totalTokens > 0) {
				used = Math.round(cum.totalTokens * 0.5);
			}
		}

		const pct = Math.min(100, Math.max(0, Math.round((used / cw) * 100)));
		return {
			percentage: pct,
			usedTokens: used,
			totalTokens: cw,
			level: pct >= 80 ? "critical" : pct >= 60 ? "warning" : "safe",
			compacting: false,
		};
	}

	async compressSession(agentId: string): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m || m.info.status === "thinking" || m.info.status === "working") return;
		// `agent:compacting` is emitted from the `compaction_start` /
		// `compaction_end` side-effect handler, not here — avoids a
		// double-emit race.
		try {
			await m.session.compact();
		} catch {}
	}

	// ============================================================
	// Agent CRUD
	// ============================================================

	/**
	 * Create a new chat agent with sensible defaults — no dialog, one click.
	 * Used by the Sidebar "新建对话" button and Cmd+N shortcut.
	 */
	async createAgent(name?: string): Promise<string> {
		const role = normalizeAgentRole("chat");
		const id = uuidv4().slice(0, 8);
		const projectCwd = this.getActiveProjectCwd();
		const settingsManager = this.settingsManagerForCwd(projectCwd, this.activeProjectId ?? undefined);
		const roleToolNames = getRoleTools(role);

		let systemPrompt = getRoleSystemPrompt(role);
		const custom = this.getProjectSettings()?.getAll().chatSystemPrompt;
		if (custom) systemPrompt = custom;

		const resourceLoader = this.buildResourceLoader({
			systemPrompt,
			agentId: id,
			cwd: projectCwd,
			settingsManager,
		});
		await resourceLoader.reload();

		const sm = SessionManager.create(projectCwd, getSessionsDir());
		const allToolNames = resolveToolNames(roleToolNames);

		// Let the SDK pick the model and thinking level. createAgentSession's
		// documented defaults are:
		//   model: "from settings, else first available"
		//   thinkingLevel: "from settings, else 'medium'"
		// SettingsManager is already populated from ~/.look/settings.json, so
		// the user's defaultProvider/defaultModel/defaultThinkingLevel are
		// respected without Look inventing its own selection logic.
		const { session } = await createAgentSession({
			cwd: projectCwd,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			tools: allToolNames,
			resourceLoader,
			sessionManager: sm,
			settingsManager,
		});

		const effectiveModel = session.model;
		if (!effectiveModel) {
			throw new Error("No model available. Configure an API key in Settings.");
		}
		const resolvedId = `${effectiveModel.provider}/${effectiveModel.id}`;
		const effectiveThinkingLevel = session.thinkingLevel;
		const availableThinkingLevels = session.getAvailableThinkingLevels();

		this.agentUsage.set(id, emptyUsageSnapshot());
		this.syncMcpToolsIntoSession(session);

		const agentName = name?.trim() || `Chat ${this.agents.size + 1}`;
		const info: AgentInfo = {
			id,
			name: agentName,
			role,
			model: resolvedId,
			thinkingLevel: effectiveThinkingLevel,
			modelSupportsThinking: effectiveModel.reasoning ?? false,
			availableThinkingLevels,
			status: "idle",
			messageCount: 0,
			createdAt: Date.now(),
			usage: emptyUsageSnapshot(),
			permissionMode: "ask",
			projectId: this.activeProjectId ?? undefined,
		};

		const managed: ManagedAgent = {
			info,
			session,
			messages: [],
			unsubscribe: session.subscribe((e) => this.handleSessionEvent(id, e)),
			permissionMode: "ask",
			leafId: session.sessionManager.getLeafId(),
		};
		this.agents.set(id, managed);

		this.addMessage(id, {
			id: uuidv4(),
			agentId: id,
			role: "system",
			contentBlocks: [
				{
					type: "text",
					text: `"${agentName}" started. Model: ${resolvedId}, Thinking: ${effectiveThinkingLevel}`,
				},
			],
			timestamp: Date.now(),
		});

		this.emit({ type: "agent:created", agentId: id, agent: { ...info } });
		this.emitAgentList();
		return id;
	}

	async destroyAgent(agentId: string): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m) return;
		m.unsubscribe();
		// Capture the session file before disposing the session —
		// `dispose()` may release the reference.
		const sessionFile = m.session.sessionFile;
		try {
			m.session.dispose();
		} catch {}
		// Remove the session.jsonl so we don't leave orphan files on
		// disk after destroying an agent. agents.json is already
		// updated below via saveIndex() (which won't re-add this one
		// because we've already removed from `this.agents`).
		if (sessionFile) {
			try {
				fs.unlinkSync(sessionFile);
			} catch (err: any) {
				// ENOENT is fine — the file may not exist if the user
				// destroyed an agent that had never sent a message
				// (SDK lazy-flush). Anything else we warn.
				if (err?.code !== "ENOENT") {
					console.warn(`[Look] Failed to remove session file ${sessionFile}:`, err);
				}
			}
		}
		this.agents.delete(agentId);
		this.agentUsage.delete(agentId);
		this.lastContextTokens.delete(agentId);
		this.firstUserMessage.delete(agentId);
		this.messageUpdateBuffers.delete(agentId);
		this.saveIndex();
		this.emit({ type: "agent:destroyed", agentId });
		this.emitAgentList();
	}

	getAgentInfo(agentId: string) {
		return this.agents.get(agentId)?.info;
	}
	listAgents() {
		const all = Array.from(this.agents.values()).map((a) => ({ ...a.info }));
		if (!this.activeProjectId) return [];
		return all.filter((a) => a.projectId === this.activeProjectId);
	}

	/**
	 * Snapshot of agents + each agent's restored history, returned in a
	 * single IPC roundtrip. This is the primary path for the renderer to
	 * bootstrap its state on mount: avoids the race where a separate
	 * `getHistory` pull happens before `loadPersistedAgents` has finished
	 * landing the agent in `this.agents`, or after a StrictMode double-
	 * mount has discarded the result.
	 */
	listAgentsWithHistory(): { agents: AgentInfo[]; history: Record<string, PiMessage[]> } {
		const agents = this.listAgents();
		const visibleIds = new Set(agents.map((agent) => agent.id));
		const history: Record<string, PiMessage[]> = {};
		for (const a of this.agents.values()) {
			if (!visibleIds.has(a.info.id)) continue;
			if (a.messages.length > 0) history[a.info.id] = a.messages;
		}
		return { agents, history };
	}
	getMessages(agentId: string) {
		return this.agents.get(agentId)?.messages ?? [];
	}

	renameAgent(agentId: string, newName: string): void {
		const m = this.agents.get(agentId);
		if (!m || !newName.trim()) return;
		m.info.name = newName.trim();
		this.saveIndex();
		this.emit({ type: "agent:updated", agentId, agent: { ...m.info } });
		this.emitAgentList();
	}

	/**
	 * 调用 AI 生成对话标题（非流式）
	 *
	 * 使用与 Agent 相同的渠道和模型，发送非流式请求，
	 * 让模型根据用户第一条消息生成简短标题。
	 */
	private async generateTitle(userMessage: string, provider: string, modelId: string): Promise<string | null> {
		// 短消息直接使用原文作为标题
		const trimmed = userMessage.trim();
		if (trimmed.length <= SHORT_MESSAGE_THRESHOLD) {
			return trimmed.slice(0, MAX_TITLE_LENGTH);
		}

		const model = this.modelRegistry.find(provider, modelId);
		if (!model) return null;
		const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return null;
		const prompt = TITLE_PROMPT + userMessage;

		try {
			const result = await completeSimple(
				model,
				{
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 64,
					timeoutMs: 15_000,
					maxRetries: 0,
				},
			);
			if (result.stopReason === "error") return null;
			const text = extractTextFromAssistantMessage(result);
			if (!text) return null;
			// 清理引号和书名号
			const cleaned = text
				.trim()
				.replace(/^["'""''「《]+|["'""''」》]+$/g, "")
				.trim();
			return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
		} catch (_err) {
			return null;
		}
	}

	/**
	 * 流完成后自动生成标题
	 *
	 * 如果 Agent 标题仍为默认值 "聊天助手"，自动调用标题生成。
	 */
	private autoGenerateTitle(agentId: string): void {
		const m = this.agents.get(agentId);
		if (!m) {
			return;
		}
		if (m.info.name !== DEFAULT_CHAT_NAME) {
			return;
		}

		// 防重：标题生成已在进行中
		if (this.titleInFlight.has(agentId)) {
			return;
		}

		const userMessage = this.firstUserMessage.get(agentId);
		if (!userMessage) {
			return;
		}

		const [p, ...parts] = m.info.model.includes("/") ? m.info.model.split("/") : ["anthropic", m.info.model];
		const modelId = parts.join("/");
		this.titleInFlight.add(agentId);

		this.generateTitle(userMessage, p, modelId)
			.then((title) => {
				this.titleInFlight.delete(agentId);
				if (!title || title === DEFAULT_CHAT_NAME) return;
				this.renameAgent(agentId, title);
			})
			.catch((err) => {
				this.titleInFlight.delete(agentId);
			});
	}

	// ============================================================
	// Messaging
	// ============================================================

	async sendMessage(agentId: string, text: string, fromAgentId?: string): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m) {
			this.emit({ type: "error", agentId, message: `Agent ${agentId} not found` });
			return;
		}
		// We do NOT pre-pend the user message to m.messages here — the
		// SDK emits user message_start + message_end itself, and the
		// renderer reads that event stream directly via the
		// pass-through in handleSessionEvent. m.messages is populated
		// at message_end with the SDK's real message (see
		// handleLookSideEffect).
		//
		// We also do NOT force status to "thinking" here. The SDK's
		// own agent_start event drives the status transition; forcing
		// it from sendMessage would race against in-flight tool calls
		// (status: "working" → "thinking" flicker).
		try {
			// If the agent is already streaming, queue the new message as a
			// "steer" so it interrupts the current turn after the next
			// tool boundary and the new instruction takes effect. Without
			// this option the SDK throws ("streaming and no
			// streamingBehavior specified"), which is the pre-P1 behavior
			// — the user's second message just bounced with an opaque
			// error. The "steer" choice is intentional: a follow-up
			// message would queue silently, and the user gets no signal
			// that the agent is still on the old turn.
			const streamingBehavior = m.session.isStreaming ? "steer" : undefined;
			await m.session.prompt(text, streamingBehavior ? { streamingBehavior } : undefined);
			const em = m.session.agent?.state?.errorMessage;
			if (em) {
				this.emit({ type: "error", agentId, message: `Agent error: ${em}` });
				this.updateStatus(agentId, "error");
			}
		} catch (err: any) {
			this.emit({ type: "error", agentId, message: `Prompt failed: ${err.message}` });
			this.updateStatus(agentId, "error");
		}
	}

	/**
	 * Abort the current generation / streaming turn. Maps to
	 * `m.session.abort()` which is fire-and-forget in the SDK: it
	 * signals the underlying agent loop to stop and the agent
	 * status naturally moves back to "idle" via the existing event
	 * stream (tool_execution_end / message_end). We do NOT set
	 * status to "idle" here — let the SDK's own events drive it, so
	 * the UI sees the same state machine as a normal turn completion.
	 *
	 * If the agent is not currently streaming this is a no-op, which
	 * matches the SDK's behavior. (Trying to abort a non-streaming
	 * agent would just create a no-op, which is fine — the user
	 * clicked Stop on a still stream, this catches the race.)
	 */
	async abortAgent(agentId: string): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m) {
			this.emit({ type: "error", agentId, message: `Agent ${agentId} not found` });
			return;
		}
		if (!m.session) return;
		if (!m.session.isStreaming) {
			// Not actively streaming, but the user may still have
			// queued messages they want to drop (e.g. queued during
			// a tool call that just returned). clearQueue() is a
			// no-op when nothing is queued.
			m.session.clearQueue();
			return;
		}
		try {
			// Clear the SDK's steering + follow-up queues before
			// aborting. The SDK emits a fresh queue_update event
			// (steering = [], followUp = []) from clearQueue, which
			// the renderer's queue drawer syncs off — so the drawer
			// empties in lockstep with the SDK's authoritative
			// state, not via a local clear.
			m.session.clearQueue();
			await m.session.abort();
		} catch (err: any) {
			this.emit({ type: "error", agentId, message: `Abort failed: ${err.message}` });
		}
	}

	// ============================================================
	// Thinking Level
	// ============================================================

	setThinkingLevel(agentId: string, level: ThinkingLevel): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		m.session.setThinkingLevel(level);
		// The SDK clamps to the model's supported levels; mirror the
		// effective value back so the UI never lies about what is active.
		m.info.thinkingLevel = m.session.thinkingLevel;
		// Re-evaluate the model's reasoning metadata in case the SDK
		// recomputed capabilities (defensive: normally unchanged).
		m.info.modelSupportsThinking = m.session.model?.reasoning ?? false;
		m.info.availableThinkingLevels = m.session.getAvailableThinkingLevels() ?? m.info.availableThinkingLevels;
		this.saveIndex();
		this.emit({ type: "agent:updated", agentId, agent: { ...m.info } });
	}

	/**
	 * Set the per-agent permission mode (ask / plan / allow).
	 * Takes effect immediately for the next tool call; in-flight
	 * tools are not interrupted.
	 */
	setPermissionMode(agentId: string, mode: PermissionMode): void {
		const m = this.agents.get(agentId);
		if (!m || m.permissionMode === mode) return;
		m.permissionMode = mode;
		m.info.permissionMode = mode;
		this.saveIndex();
		this.emit({ type: "agent:permission-mode", agentId, mode });
		this.emit({ type: "agent:updated", agentId, agent: { ...m.info } });
	}

	/** Read-only accessor for the permission ask service (used by IPC). */
	getPermissionAsk(): PermissionAskService {
		return this.permissionAsk;
	}

	// ============================================================
	// Model Switching
	// ============================================================

	/**
	 * Switch an agent's model in-place via the SDK's `setModel`.
	 *
	 * Preserves the session, message history, and agent ID — unlike
	 * the previous destroy+recreate approach which lost all in-flight
	 * state and contaminated the conversation with a fake "Session
	 * restored" message.
	 *
	 * Throws if the new model isn't found, the agent doesn't exist, or
	 * the agent has no live session (e.g. it was restored from disk
	 * without a live pi session and hasn't been touched yet).
	 */
	async setModel(agentId: string, modelKey: string): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m) throw new Error(`Agent not found: ${agentId}`);
		if (!m.session) throw new Error(`Agent ${agentId} has no live session`);

		const [provider, ...idParts] = modelKey.includes("/") ? modelKey.split("/") : ["anthropic", modelKey];
		const modelId = idParts.join("/");
		const model = this.lookupModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${modelKey}`);

		// Pre-flight: the SDK will throw on its own (auth lookup) but
		// the error is opaque ("no credentials" deep in pi internals).
		// Catching it here gives the renderer a clean message it can
		// surface in a toast and roll the model selector back.
		if (!this.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`Provider '${provider}' is not configured. Add an API key in Settings first.`);
		}

		await m.session.setModel(model);
		m.info.model = modelKey;
		m.info.modelSupportsThinking = model.reasoning ?? false;
		// setModel re-clamps the thinking level to the new model's
		// capabilities, so keep Look's mirror in sync.
		m.info.thinkingLevel = m.session.thinkingLevel;
		m.info.availableThinkingLevels = m.session.getAvailableThinkingLevels();
		this.saveIndex();
		this.emit({ type: "agent:updated", agentId, agent: { ...m.info } });
	}

	// ============================================================
	// ============================================================
	// Session Event Handling
	//
	// pi SDK AgentSession events are passed through to the renderer
	// with an `agent:` namespace prefix (see `MainToRendererEvent` in
	// shared/types.ts). Look-internal bookkeeping (status tracking,
	// message persistence, tool-call records, permission gate,
	// context-usage + auto-compress) is layered on top via the
	// `handleLookSideEffect` hook — it does NOT mutate the event
	// payload, only reads it and emits additional Look-specific
	// events (status / permission:request / context-usage).
	// ============================================================

	private handleSessionEvent(agentId: string, event: any): void {
		const m = this.agents.get(agentId);
		if (!m) return;

		// 1) Look-internal side effects (no payload mutation)
		this.handleLookSideEffect(agentId, event);

		// 2) Pass-through to renderer with `agent:` prefix.
		// Skip events that are still in flight for a tool call we
		// locally blocked — in that case pi's tool_execution_end will
		// also arrive; we don't want a double emit.
		if (this.isLocallyBlocked(agentId, event)) return;

		// Look-internal bookkeeping (m.messages bookkeeping, status,
		// usage tracking) runs in handleLookSideEffect above. The
		// event itself is passed through to the renderer with an
		// `agent:` prefix — the renderer reads message_start /
		// message_update / message_end from THIS stream, so we must
		// NOT also synthesize a message_start from addMessage (that
		// would race with the SDK's real event and break id
		// correlation in the UI).

		// Batch high-frequency message_update events at ~16ms to avoid
		// IPC flooding the renderer on every token delta.
		if (event.type === "message_update") {
			this.bufferMessageUpdate(agentId, event);
			return;
		}
		this.flushMessageUpdates();
		this.emit(this.toRendererEvent(agentId, event));
	}

	/** Convert a pi session event to a Look-namespaced renderer event. */
	private toRendererEvent(agentId: string, event: any): any {
		// Pass pi's payload fields through unchanged; just rewrite `type`
		// and inject `agentId` so the renderer can correlate.
		return { ...event, type: `agent:${event.type}`, agentId };
	}

	/** Buffer high-frequency message_update events and flush at 16ms. */
	private bufferMessageUpdate(agentId: string, event: any): void {
		this.messageUpdateBuffers.set(agentId, event);
		if (!this.messageUpdateFlushTimer) {
			this.messageUpdateFlushTimer = setTimeout(() => this.flushMessageUpdates(), 16);
		}
	}

	private flushMessageUpdates(): void {
		if (this.messageUpdateFlushTimer) {
			clearTimeout(this.messageUpdateFlushTimer);
			this.messageUpdateFlushTimer = null;
		}
		for (const [agentId, event] of this.messageUpdateBuffers) {
			this.emit(this.toRendererEvent(agentId, event));
		}
		this.messageUpdateBuffers.clear();
	}

	/**
	 * Split a stored model key like `"anthropic/claude-3-5-sonnet"`
	 * into `[provider, modelId]`. Mirrors the convention used by
	 * `ModelRegistry` lookups.
	 */
	private splitModelKey(key: string): [string, string] {
		const slash = key.indexOf("/");
		if (slash < 0) return ["anthropic", key];
		return [key.slice(0, slash), key.slice(slash + 1)];
	}

	/** Tool calls blocked by the permission gate (locally). */
	private blockedToolCalls = new Map<string, Set<string>>();

	private isLocallyBlocked(agentId: string, event: any): boolean {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			return false; // still let the renderer see the start/update
		}
		if (event.type === "tool_execution_end") {
			const blocked = this.blockedToolCalls.get(agentId);
			if (blocked?.has(event.toolCallId)) {
				blocked.delete(event.toolCallId);
				if (blocked.size === 0) this.blockedToolCalls.delete(agentId);
				return true; // we already emitted a synthetic tool-end; skip pi's
			}
		}
		return false;
	}

	/** Look-specific bookkeeping that runs on every pi session event. */
	private handleLookSideEffect(agentId: string, event: any): void {
		const m = this.agents.get(agentId);
		if (!m) return;

		switch (event.type) {
			case "message_start": {
				// m.messages is populated at message_end with the SDK's
				// finalized message (real id, real content, real usage).
				// No placeholder is needed here — the renderer reads the
				// SDK's real message_start event via the pass-through in
				// handleSessionEvent. Synthesizing a placeholder from
				// addMessage would race with the SDK's event and break
				// message-id correlation in the UI.
				//
				// v0.4: but we DO need to mirror the leaf here —
				// message_start is the SDK's signal that the leaf just
				// advanced (appendMessage is internal to pi, so we
				// can't observe it directly). Sync the mirror and
				// tell the renderer the tree shape may have changed.
				this.syncLeafFromSession(agentId);
				break;
			}
			case "message_end": {
				const msg = event.message;
				let recordedMessage = false;
				// Push the SDK's finalized message (real id, real content,
				// real usage) into m.messages so getMessages() /
				// listAgentsWithHistory() / the persisted-agents restore
				// path see it. The renderer reads message_end from the
				// pass-through, not from this bookkeeping. We dedupe by
				// id because the SDK may replay the same event after a
				// retry — without the check, m.messages would grow
				// monotonically across retries.
				if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
					const realId = (msg as any).id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
					if (!m.messages.some((x) => x.id === realId)) {
						this.addMessage(agentId, convertPiMessage(msg, agentId, realId));
						recordedMessage = true;
					}
				}
				if (recordedMessage && msg?.role === "assistant" && msg.usage) this.trackUsage(agentId, msg.usage);
				m.info.messageCount = m.messages.length;

				// 记录首条用户消息并立即启动标题生成（与 AI 回复并行）
				if (msg?.role === "user" && !this.firstUserMessage.has(agentId)) {
					const text = extractTextFromPiMessage(msg);
					if (text) {
						this.firstUserMessage.set(agentId, text);
						// 不等 assistant 回复完成，标题 API 调用与回复并行
						this.autoGenerateTitle(agentId);
					}
				}

				// Commit the agent to `agents.json` only once the SDK has
				// flushed a session.jsonl to disk. The SDK has a lazy-flush
				// policy: the file is only created when the FIRST assistant
				// message lands (user / tool messages stay in memory until
				// then). Gating `saveIndex()` on `existsSync(sessionFile)`
				// means:
				//   - user message_end: sessionFile doesn't exist yet →
				//     no commit. (User message alone = "not a real
				//     conversation" by our product rule, so it should not
				//     survive a restart.)
				//   - assistant message_end: sessionFile now exists on
				//     disk → commit. The agent becomes restorable.
				// We deliberately do NOT seed an empty session.jsonl
				// ourselves — the SDK owns file creation via its
				// `openSync(file, "wx")` path and any seeded file would
				// race against it.
				const sessionFile = m.session.sessionFile;
				if (sessionFile && fs.existsSync(sessionFile)) {
					this.saveIndex();
				}

				// 首次 assistant 回复到达后自动生成标题。
				// 不绑在 sessionFile 上——pi SDK 异步落盘，事件发射时文件未必已写完。
				if (msg?.role === "assistant") {
					this.autoGenerateTitle(agentId);
				}

				// Context ring (Look-specific)
				const ctx = this.getContextUsage(agentId);
				if (ctx) this.emit({ type: "agent:context-usage", agentId, usage: ctx });
				break;
			}
			case "tool_execution_start": {
				// Track tool call in the local message AND enforce permission gate.
				this.updateStatus(agentId, "working");
				const tm =
					[...m.messages].reverse().find((x) => x.isStreaming && x.role === "assistant") ??
					[...m.messages].reverse().find((x) => x.role === "assistant");
				if (tm) {
					const block = tm.contentBlocks.find(
						(b) =>
							b.type === "toolCall" &&
							((b as PiToolCallBlock).id === event.toolCallId ||
								((b as PiToolCallBlock).status === "pending" && !(b as PiToolCallBlock).id)),
					) as PiToolCallBlock | undefined;
					if (!block) {
						tm.contentBlocks.push({
							type: "toolCall",
							id: event.toolCallId,
							name: event.toolName,
							arguments: event.args ?? {},
							status: "running",
							result: "",
							isError: false,
						});
					} else {
						block.status = "running";
						block.name = event.toolName || block.name;
						if (event.args) block.arguments = event.args;
					}
				}
				const perm = checkPermission(event.toolName, event.args ?? {}, m.info.role);
				if (perm.action === "deny") {
					// Mark for skip in pass-through; the synthetic tool-end is
					// emitted here so the renderer still sees the failure.
					// Note: real pre-execution blocking happens in the
					// extensionFactory's `tool_call` hook. This is a
					// belt-and-suspenders fallback in case the extension
					// didn't fire.
					(this.blockedToolCalls.get(agentId) ?? this.blockedToolCalls.set(agentId, new Set()).get(agentId)!).add(
						event.toolCallId,
					);
					this.emit({
						type: "agent:tool_execution_end",
						agentId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: { content: [{ type: "text", text: `BLOCKED: ${perm.reason}` }] },
						isError: true,
					});
				}
				// The "ask" path is fully handled by the extensionFactory
				// registered in buildResourceLoader — it suspends the tool
				// until the renderer responds. We do nothing here.
				break;
			}
			case "tool_execution_end": {
				const tm = [...m.messages]
					.reverse()
					.find(
						(x) =>
							x.role === "assistant" &&
							x.contentBlocks.some(
								(b) => b.type === "toolCall" && (b as PiToolCallBlock).id === event.toolCallId,
							),
					);
				if (tm) {
					const block = tm.contentBlocks.find(
						(b) => b.type === "toolCall" && (b as PiToolCallBlock).id === event.toolCallId,
					) as PiToolCallBlock | undefined;
					if (block) {
						block.status = event.isError ? "error" : "success";
						block.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
						block.isError = event.isError;
					}
				}
				break;
			}
			case "agent_start": {
				this.updateStatus(agentId, "thinking");
				break;
			}
			case "agent_end": {
				this.updateStatus(agentId, "idle");
				// After a turn completes, the SDK has committed all
				// messages to the session tree (with real UUID entry
				// IDs). Rebuild m.messages from the tree so future
				// navigateTree / createFork calls get correct entry
				// IDs instead of the synthetic m_xxx fallback IDs
				// we used during streaming.
				{
					const rebuilt = this.rebuildMessagesFromSession(agentId);
					if (rebuilt.length > 0) {
						const oldLen = m.messages.length;
						m.messages = rebuilt;
						m.info.messageCount = rebuilt.length;
						this.emit({ type: "agent:history", agentId, messages: rebuilt });
						// Re-emit tree-changed so the renderer picks up the
						// latest leafId after the turn.
						this.syncLeafFromSession(agentId);
						// Persist the new leaf so a restart doesn't undo the switch.
						this.saveIndex();
						// Only log when IDs actually changed (first
						// turn after restart already has correct IDs).
						if (oldLen === rebuilt.length) {
							console.log(`[Look] Synced message IDs for agent ${agentId} (${rebuilt.length} messages)`);
						}
					}
				}
				break;
			}
			case "compaction_start": {
				this.emit({ type: "agent:compacting", agentId, compacting: true });
				break;
			}
			case "compaction_end": {
				this.emit({ type: "agent:compacting", agentId, compacting: false });
				break;
			}
		}
	}

	// ============================================================
	// Session tree / branching (v0.4)
	// ============================================================

	/**
	 * Pull the current leafId from the SDK's SessionManager and
	 * mirror it on `m.leafId`. Emits `agent:tree-changed` so the
	 * renderer can refresh its tree-view and breadcrumb.
	 *
	 * Called from `message_start` (where the leaf advances due to
	 * `appendMessage`) and at the tail of `navigateTreeSession` /
	 * `createForkedSession` (which move the leaf via the SDK's
	 * own `navigateTree` / `createBranchedSession`).
	 */
	private syncLeafFromSession(agentId: string): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		const newLeaf = m.session.sessionManager.getLeafId();
		if (newLeaf === m.leafId) return; // no-op when nothing moved
		m.leafId = newLeaf;
		const tree = this.snapshotTreeForRenderer(agentId);
		if (tree) {
			this.emit({ type: "agent:tree-changed", agentId, leafId: newLeaf, tree });
		}
	}

	/**
	 * Flatten pi's `SessionTreeNode` into the IPC-friendly shape
	 * declared in `shared/types.ts`. Caps `textPreview` to keep the
	 * payload small (a long conversation can otherwise balloon a
	 * single IPC frame).
	 */
	private snapshotTreeForRenderer(agentId: string): SessionTreeNode | null {
		const m = this.agents.get(agentId);
		if (!m) return null;
		const roots = m.session.sessionManager.getTree();
		// A well-formed session has exactly one root; defensively
		// pick the first if there are multiple (orphans etc.).
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

	private toRendererTreeNode(n: any): SessionTreeNode {
		const entry = n.entry ?? {};
		const node: SessionTreeNode = {
			id: entry.id,
			parentId: entry.parentId,
			type: entry.type,
			timestamp: entry.timestamp,
			children: (n.children ?? []).map((c: any) => this.toRendererTreeNode(c)),
		};
		if (entry.type === "message" && entry.message) {
			node.role = entry.message.role;
			const text = this.previewTextFromMessage(entry.message);
			if (text) node.textPreview = text;
		} else if (entry.type === "branch_summary") {
			node.summary = entry.summary;
		} else if (entry.type === "label") {
			node.label = entry.label;
		}
		return node;
	}

	private previewTextFromMessage(msg: any): string {
		const MAX = 120;
		if (typeof msg.content === "string") return msg.content.slice(0, MAX);
		if (Array.isArray(msg.content)) {
			const text = msg.content
				.filter((b: any) => b?.type === "text")
				.map((b: any) => b.text ?? "")
				.join(" ")
				.trim();
			return text.slice(0, MAX);
		}
		return "";
	}

	/** Read the tree for an agent. Cheap (in-memory traversal). */
	getSessionTree(agentId: string): SessionTreeNode | null {
		return this.snapshotTreeForRenderer(agentId);
	}

	/** Read the leafId for an agent (null if no entries yet). */
	getLeafId(agentId: string): string | null {
		const m = this.agents.get(agentId);
		if (!m) return null;
		// Always read fresh — `m.leafId` is a mirror and could
		// drift if the SDK is mid-write; `getLeafId()` is cheap.
		return m.session.sessionManager.getLeafId();
	}

	/**
	 * List user messages the user can pick as a fork point.
	 * Thin wrapper around `AgentSession.getUserMessagesForForking()`
	 * which already returns `{ entryId, text }` pairs.
	 */
	getForkPoints(agentId: string): SessionForkPoint[] {
		const m = this.agents.get(agentId);
		if (!m) return [];
		const raw = m.session.getUserMessagesForForking();
		return raw.map((r) => {
			const e = m.session.sessionManager.getEntry(r.entryId);
			return {
				entryId: r.entryId,
				text: r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text,
				timestamp: e?.timestamp ?? new Date().toISOString(),
			};
		});
	}

	/**
	 * Navigate the active branch. Wraps `AgentSession.navigateTree`
	 * which is the same code path the pi TUI uses — it handles
	 * "land on user message → put text in editor", summary prompts,
	 * and the cancel button in one call. After the SDK moves the
	 * leaf we re-emit the agent's history so the renderer can
	 * replace its message list (this is the only way the renderer
	 * knows to drop messages from the abandoned branch).
	 */
	async navigateTreeSession(
		agentId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		const m = this.agents.get(agentId);
		if (!m) {
			throw new Error(`Agent ${agentId} not found`);
		}
		if (m.info.status === "thinking" || m.info.status === "working") {
			throw new Error("Cannot navigate the tree while the agent is generating. Stop the current turn first.");
		}
		const result = await m.session.navigateTree(entryId, {
			summarize: opts?.summarize,
			customInstructions: opts?.customInstructions,
			label: opts?.label,
		});
		if (result.cancelled) {
			// Renderer may want to keep the user on the old leaf —
			// nothing to do here, the SDK already restored the leaf.
			return { cancelled: true };
		}
		// Rebuild the message list from the new active branch. We
		// mirror the `loadPersistedAgents` extraction so the
		// renderer gets the same shape it knows how to render.
		const messages = this.rebuildMessagesFromSession(agentId);
		this.emit({ type: "agent:history", agentId, messages });
		this.syncLeafFromSession(agentId);
		// Persist the new leaf so a restart doesn't undo the switch.
		this.saveIndex();
		return {
			cancelled: false,
			editorText: result.editorText,
			aborted: result.aborted,
		};
	}

	/**
	 * Create a new agent that holds an extracted branch as its own
	 * session file. Mirrors what `/fork` does in the pi TUI: copy
	 * the path from root to `entryId` into a brand-new .jsonl, then
	 * open a new AgentSession against it. The new agent is
	 * registered in `this.agents` and broadcast via `agent:created`.
	 */
	async createForkedSession(agentId: string, entryId: string, opts?: { name?: string }): Promise<ForkedSessionResult> {
		const src = this.agents.get(agentId);
		if (!src) throw new Error(`Agent ${agentId} not found`);

		const newSessionFile = src.session.sessionManager.createBranchedSession(entryId);
		if (!newSessionFile) {
			throw new Error("Failed to create the forked session file (in-memory session?)");
		}

		// Open the brand-new file and build a fresh AgentSession
		// against it. The session file already carries the model/thinking
		// state from the parent branch, so let the SDK restore it rather
		// than pinning a Look-derived model.
		const sm = SessionManager.open(newSessionFile);
		const sourceCwd = this.getAgentCwd(agentId);
		const settingsManager = this.settingsManagerForCwd(sourceCwd, src.info.projectId);
		const role = normalizeAgentRole(src.info.role);
		const roleToolNames = getRoleTools(role);
		let systemPrompt = getRoleSystemPrompt(role);
		if (role === "chat") {
			const custom = this.getProjectSettings(src.info.projectId)?.getAll().chatSystemPrompt;
			if (custom) systemPrompt = custom;
		}
		const newId = uuidv4().slice(0, 8);
		const resourceLoader = this.buildResourceLoader({
			systemPrompt,
			agentId: newId,
			cwd: sourceCwd,
			settingsManager,
		});

		await resourceLoader.reload();
		const allToolNames = resolveToolNames(roleToolNames);

		const { session } = await createAgentSession({
			cwd: sourceCwd,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			sessionManager: sm,
			settingsManager,
			tools: allToolNames,
			resourceLoader,
		});

		this.syncMcpToolsIntoSession(session);

		const effectiveModel = session.model;
		if (!effectiveModel) {
			throw new Error(`No model available for forked session`);
		}
		const resolvedId = `${effectiveModel.provider}/${effectiveModel.id}`;

		const forkName = (opts?.name ?? `${src.info.name} · fork`).slice(0, MAX_NAME_LEN);
		const info: AgentInfo = {
			id: newId,
			name: forkName,
			role,
			model: resolvedId,
			thinkingLevel: session.thinkingLevel,
			modelSupportsThinking: effectiveModel.reasoning ?? false,
			availableThinkingLevels: session.getAvailableThinkingLevels(),
			status: "idle",
			messageCount: 0,
			createdAt: Date.now(),
			usage: emptyUsageSnapshot(),
			permissionMode: src.info.permissionMode,
			sessionFilePath: newSessionFile,
			projectId: src.info.projectId,
		};

		// Pull messages from the new file's branch so the renderer
		// sees the fork's content immediately (no waiting for the
		// first user message).
		const messages = this.extractMessagesFromSessionManager(sm, newId);
		const managed: ManagedAgent = {
			info,
			session,
			messages,
			unsubscribe: session.subscribe((e) => this.handleSessionEvent(newId, e)),
			permissionMode: src.info.permissionMode,
			leafId: sm.getLeafId(),
		};
		this.agents.set(newId, managed);
		this.agentUsage.set(newId, emptyUsageSnapshot());

		// The first real message in the new agent must come from
		// the user, not from a synthetic system message — we want
		// the fork to land cleanly on `entryId`'s user prompt.
		// (mirrors `createAgent`'s pattern of seeding a system
		// message; here the new file already has the user's
		// prompt at the tip, so no seed is needed.)

		this.saveIndex();
		this.emit({ type: "agent:created", agentId: newId, agent: { ...info } });
		this.emit({ type: "agent:history", agentId: newId, messages });
		this.emitAgentList();
		return { agentId: newId, sessionFilePath: newSessionFile };
	}

	/**
	 * Set or clear a user-defined label on any entry. Labels are
	 * rendered as bookmarks in the future tree-view UI; they do
	 * NOT participate in LLM context.
	 */
	setEntryLabel(agentId: string, entryId: string, label: string | null): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		// Treat empty string as "clear" — the renderer can pass `""`
		// from an input's onBlur and expect a remove.
		const next = label && label.trim().length > 0 ? label.trim() : undefined;
		const oldLeaf = m.session.sessionManager.getLeafId();
		m.session.sessionManager.appendLabelChange(entryId, next);
		if (oldLeaf === null) {
			m.session.sessionManager.resetLeaf();
		} else {
			m.session.sessionManager.branch(oldLeaf);
		}
		m.leafId = oldLeaf;
		const tree = this.snapshotTreeForRenderer(agentId);
		if (tree) {
			this.emit({ type: "agent:tree-changed", agentId, leafId: oldLeaf, tree });
		}
		this.saveIndex();
	}

	/**
	 * Re-run the same `getBranch() → convert` extraction as
	 * `loadPersistedAgents`, but against an already-open
	 * SessionManager. Used after `navigateTree` to rebuild the
	 * renderer's message list.
	 */
	private rebuildMessagesFromSession(agentId: string): PiMessage[] {
		const m = this.agents.get(agentId);
		if (!m) return [];
		return this.extractMessagesFromSessionManager(m.session.sessionManager, agentId);
	}

	private extractMessagesFromSessionManager(sm: any, agentId: string): PiMessage[] {
		const branch = sm.getBranch();
		const out: PiMessage[] = [];
		for (const e of branch) {
			if (e.type === "branch_summary") {
				const timestamp =
					typeof e.timestamp === "number"
						? e.timestamp
						: Number.isFinite(new Date(e.timestamp).getTime())
							? new Date(e.timestamp).getTime()
							: Date.now();
				out.push(
					convertPiMessage(
						{
							role: "branchSummary",
							summary: e.summary,
							fromId: e.fromId ?? e.parentId ?? "root",
							timestamp,
						},
						agentId,
						e.id,
					),
				);
				continue;
			}
			if (e.type !== "message") continue;
			const msg = e.message;
			if (msg.role === "bashExecution" || msg.role === "custom" || msg.role === "compactionSummary") continue;
			out.push(convertPiMessage(msg, agentId, e.id));
		}
		// Same tool-result backfill as loadPersistedAgents (keeps
		// toolCall blocks in assistant messages rich with result).
		for (const tmsg of out) {
			if (tmsg.role !== "tool") continue;
			const tcId = (tmsg as any)._toolCallId as string | undefined;
			const isErr = (tmsg as any)._isError as boolean | undefined;
			if (!tcId) continue;
			for (const am of out) {
				if (am.role !== "assistant") continue;
				const block = am.contentBlocks.find((b) => b.type === "toolCall" && (b as PiToolCallBlock).id === tcId) as
					| PiToolCallBlock
					| undefined;
				if (!block) continue;
				block.result =
					(tmsg as any).contentBlocks
						?.filter((bb: any) => bb.type === "text")
						.map((bb: any) => bb.text ?? "")
						.join("\n") ?? "";
				block.isError = isErr ?? false;
				block.status = isErr ? "error" : "success";
				break;
			}
		}
		return out;
	}

	// ============================================================
	// Usage
	// ============================================================

	private trackUsage(agentId: string, usage: any): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		this.lastContextTokens.set(agentId, usage.input ?? 0);
		const snap: UsageSnapshot = {
			inputTokens: usage.input ?? 0,
			outputTokens: usage.output ?? 0,
			cacheReadTokens: usage.cacheRead ?? 0,
			cacheWriteTokens: usage.cacheWrite ?? 0,
			totalTokens: usage.totalTokens ?? 0,
			cost: {
				input: usage.cost?.input ?? 0,
				output: usage.cost?.output ?? 0,
				cacheRead: usage.cost?.cacheRead ?? 0,
				cacheWrite: usage.cost?.cacheWrite ?? 0,
				total: usage.cost?.total ?? 0,
			},
		};
		const cum = cloneUsageSnapshot(this.agentUsage.get(agentId));
		cum.inputTokens += snap.inputTokens;
		cum.outputTokens += snap.outputTokens;
		cum.cacheReadTokens += snap.cacheReadTokens;
		cum.cacheWriteTokens += snap.cacheWriteTokens;
		cum.totalTokens += snap.totalTokens;
		cum.cost.input += snap.cost.input;
		cum.cost.output += snap.cost.output;
		cum.cost.cacheRead += snap.cost.cacheRead;
		cum.cost.cacheWrite += snap.cost.cacheWrite;
		cum.cost.total += snap.cost.total;
		this.agentUsage.set(agentId, cum);
		m.info.usage = cloneUsageSnapshot(cum);
		this.emit({ type: "agent:usage-update", agentId, usage: cloneUsageSnapshot(cum) });
	}

	// ============================================================
	// Helpers
	// ============================================================

	private updateStatus(agentId: string, status: AgentStatus): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		m.info.status = status;
		this.emit({ type: "agent:status", agentId, status });
	}

	/**
	 * Append a message to an agent's local store. This is a pure
	 * bookkeeping call — it does NOT emit a renderer-facing event.
	 *
	 * The renderer reads message_start / message_end from the SDK's
	 * own event stream (see handleSessionEvent + toRendererEvent),
	 * not from a synthetic Look-only event. Emitting one here would
	 * race with the SDK's real event and break message-id correlation
	 * in the UI (the placeholder's uuidv4 id never matches the SDK's
	 * final id).
	 *
	 * Callers:
	 *   - handleLookSideEffect's `message_end` — pushes the SDK's
	 *     finalized message (real id, real content, real usage) so
	 *     m.messages feeds getMessages() / listAgentsWithHistory() /
	 *     the persisted-agents restore path.
	 */
	private addMessage(agentId: string, msg: PiMessage): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		m.messages.push(msg);
		m.info.messageCount = m.messages.length;
	}

	private emitAgentList(): void {
		this.emit({ type: "agent:list", agentId: "", agents: this.listAgents() });
	}

	onEvent(cb: EventCallback): () => void {
		this.eventCallbacks.push(cb);
		return () => {
			this.eventCallbacks = this.eventCallbacks.filter((c) => c !== cb);
		};
	}

	private emit(event: MainToRendererEvent) {
		for (const cb of this.eventCallbacks) {
			try {
				cb(event);
			} catch {}
		}
	}

	// ============================================================
	// Resource Loader — Inject permission gate as an inline extension
	//
	// This is the *true* pre-execution gate. pi fires the `tool_call`
	// event before running the tool, with `event.input` mutable. We:
	//   1) read the per-agent permission mode
	//   2) consult permission-gate.ts (deny/allow/ask)
	//   3) for "ask", suspend the tool until the renderer responds
	//   4) for "edit", patch event.input in place (pi doesn't re-validate)
	//
	// This is invoked once per agent at session creation.
	// ============================================================

	private buildResourceLoader(opts: {
		systemPrompt: string;
		agentId: string;
		cwd: string;
		settingsManager?: SettingsManager;
	}): DefaultResourceLoader {
		// v0.3 skills: feed ALL discovered skill paths into the SDK's
		// resource loader so agent sessions see the same skills as the
		// UI's slash menu. gatherSkillPaths() returns all paths that
		// actually exist on disk (Look project + user, agentskills.io,
		// Claude Code, Cursor, Codex, Copilot, Hermes Agent, pi SDK,
		// and user-imported paths from settings.json).
		const skillPaths = gatherSkillPaths(opts.cwd);

		return new DefaultResourceLoader({
			cwd: opts.cwd,
			// Resource discovery (extensions / skills / prompts / themes /
			// context files) lives under `~/.look/` so it lines up with
			// our AuthStorage / ModelRegistry / SessionManager paths.
			// The SDK default `getAgentDir()` would point at the global
			// `~/.pi/agent/`, which is what the `pi` CLI uses — we don't
			// want to inherit that scope.
			agentDir: getLookDir(),
			settingsManager: opts.settingsManager ?? this.settingsManagerForCwd(opts.cwd),
			// v0.3: feed all discovered skill paths into the SDK's loader so
			// they get auto-injected into worker system prompts.
			...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
			systemPromptOverride: () => opts.systemPrompt,
			appendSystemPromptOverride: () => [],
			extensionFactories: [
				(pm: any) => {
					const mcpExt = createMcpExtensionFactory(this.getMcpManager());
					mcpExt(pm);
				},
				(pi: any) => {
					// Closure captures the agentId this loader is bound to.
					// Every session built from this loader belongs to one agent.
					const agentId = opts.agentId;

					pi.on("tool_call", async (event: any) => {
						const m = this.agents.get(agentId);
						if (!m) return; // no agent — let pi run

						const mode = m.permissionMode;

						// ---- Mode: allow ----
						if (mode === "allow") return;

						// ---- Mode: plan ----
						if (mode === "plan") {
							if (READ_ONLY_TOOLS.has(event.toolName)) return;
							return {
								block: true,
								reason: `Plan mode: "${event.toolName}" is not a read-only tool. Switch to Ask or Allow to enable edits.`,
							};
						}

						// ---- Mode: ask ----
						const perm = checkPermission(event.toolName, event.input, m.info.role);
						if (perm.action === "allow") return;
						if (perm.action === "deny") {
							return { block: true, reason: perm.reason };
						}
						// ask: surface a question panel in the renderer.
						const decision = await this.permissionAsk.ask(agentId, {
							requestId: event.toolCallId,
							agentId,
							toolName: event.toolName,
							args: event.input as Record<string, unknown>,
							reason: perm.reason,
						});
						if (decision.action === "deny") {
							return { block: true, reason: decision.reason || "Denied by user" };
						}
						if (decision.action === "edit") {
							// Patch event.input in place — pi's docs say no re-
							// validation happens after this.
							for (const [k, v] of Object.entries(decision.args)) {
								(event.input as Record<string, unknown>)[k] = v;
							}
							return;
						}
						// allow
						return;
					});
				},
			],
		});
	}
}
