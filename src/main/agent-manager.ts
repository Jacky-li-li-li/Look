// ============================================================
// AgentManager — Multi-Agent Orchestration Core
//
// Persistence: pi SessionManager manages session .jsonl files natively
// (create/open/auto-save). We only store a lightweight agents.json index
// mapping agentId → sessionFile.
// ============================================================

import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { findEnvKeys, getModel } from "@earendil-works/pi-ai";
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
import { getRoleDefaults, getRoleSystemPrompt, getRoleTools } from "./agents/roles.js";
import { migrateLegacySettings } from "./migrate-settings.js";
import { PermissionAskService } from "./permissions/permission-ask.js";
import { checkPermission } from "./permissions/permission-gate.js";
import {
	ensureLookDir,
	getAgentsIndexPath,
	getAuthPath,
	getLookDir,
	getModelsPath,
	getSessionsDir,
	getUiSettingsPath,
} from "./shared/look-storage.js";
import { convertPiMessage } from "./shared/message-convert.js";
import type {
	AgentInfo,
	AgentMessage,
	AgentRole,
	AgentStatus,
	ContextUsageInfo,
	MainToRendererEvent,
	PermissionMode,
	TaskNode,
	ThinkingLevel,
	UsageSnapshot,
} from "./shared/types.js";
import {
	findSkill,
	formatInvocation,
	getLookProjectSkillsDir,
	invalidateSkillCache,
	type LoadedSkills,
	listAllSkills,
} from "./skills/skill-loader.js";
import { createOrchestrationTools } from "./tools/orchestration.js";
import { type UserSettings, UserSettingsStore } from "./user-settings.js";

/** Tools allowed in "plan" mode. Anything else is hard-blocked. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Names of pi's built-in coding-agent tools (the default 7). */
const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

/** Per-session settings baseline. Used by `createAgent` and
 *  `loadPersistedAgents` so the two paths can't drift apart. */
function makeBaseSettings() {
	return SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 30000 },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
	});
}

/** Filter a role's tool list down to (built-ins) + (custom tool names). */
function resolveToolNames(roleToolNames: string[] | null, customTools: Array<{ name: string }>): string[] {
	const builtins = new Set(BUILTIN_TOOL_NAMES);
	const builtinSelection = (roleToolNames ?? [...BUILTIN_TOOL_NAMES]).filter((t) => builtins.has(t));
	return [...builtinSelection, ...customTools.map((t) => t.name)];
}

// ============================================================
// Types
// ============================================================

export interface CreateAgentOptions {
	name: string;
	role: AgentRole;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fallbackModels?: string[];
	parentAgentId?: string;
}

interface ManagedAgent {
	info: AgentInfo;
	session: AgentSession;
	messages: AgentMessage[];
	unsubscribe: () => void;
	resolveWaits?: (() => void)[];
	/** Per-agent permission mode (ask / plan / allow). */
	permissionMode: PermissionMode;
}

export type EventCallback = (event: MainToRendererEvent) => void;

/**
 * Resolve the env-var name for a provider via the SDK's own
 * `findEnvKeys()` (covers all built-in providers and any custom
 * one declared in `~/.look/models.json`). Falls back to the
 * convention `PROVIDER_API_KEY` for unknown providers — kept as a
 * last-resort so the Settings UI still surfaces a hint.
 */
function envVarForProvider(provider: string): string {
	const keys = findEnvKeys(provider);
	if (keys && keys.length > 0) return keys[0];
	return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

const EMPTY_USAGE: UsageSnapshot = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ============================================================
// AgentManager
// ============================================================

export class AgentManager {
	private agents = new Map<string, ManagedAgent>();
	private eventCallbacks: EventCallback[] = [];
	private permissionAsk = new PermissionAskService((event) => this.emit(event));
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private userSettings: UserSettingsStore;
	private cwd: string;

	private agentUsage = new Map<string, UsageSnapshot>();
	private lastContextTokens = new Map<string, number>();
	private lastCompactPct = new Map<string, number>();
	private agentsIndexPath: string;

	constructor(cwd?: string) {
		this.cwd = cwd ?? process.cwd();
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
		// UserSettingsStore's SDK fields (thinkingLevel / preferredModel)
		// ride on the SDK's `~/.look/settings.json`; its UI fields
		// (language / autoCollapse / autoCompress / compressThreshold)
		// live in a sibling `~/.look/ui-settings.json` since the SDK
		// schema doesn't carry them.
		const settingsManager = SettingsManager.create(this.cwd, getLookDir());
		this.userSettings = new UserSettingsStore(settingsManager, getUiSettingsPath());
		this.agentsIndexPath = getAgentsIndexPath();
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
					sessionFile: m.session.sessionFile ?? undefined,
					permissionMode: m.permissionMode,
					usage: m.info.usage,
				})),
			};
			fs.writeFileSync(this.agentsIndexPath, JSON.stringify(data, null, 2));
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

				// Open pi session from existing file
				const sm = SessionManager.open(sessionFile);

				// Extract messages from the session tree
				// Use getBranch() (not getEntries()) — sessions are a tree, and
				// getEntries() returns entries from ALL branches including ones
				// the user has abandoned. getBranch() walks from the current
				// leaf to root, which is what we want for a linear conversation.
				const branch = sm.getBranch();
				const uiMessages: AgentMessage[] = [];
				for (const e of branch) {
					if (e.type !== "message") continue;
					const msg = e.message;
					// Skip pi-internal message types (bashExecution, custom, etc.)
					if (
						msg.role === "bashExecution" ||
						msg.role === "custom" ||
						msg.role === "branchSummary" ||
						msg.role === "compactionSummary"
					)
						continue;
					uiMessages.push(convertPiMessage(msg, id, e.id));
				}

				// Pre-flight the persisted model: the user may have removed
				// the API key for that provider since the session was last
				// active, in which case rehydrating with `entry.model` would
				// crash deep in pi internals on the auth lookup. Walk the
				// fallback chain the same way `createAgent` does and surface
				// the swap to the renderer so it can show the same toast
				// the create-time fallback path already does.
				const persistedModel = entry.model ?? "";
				let resolvedModelKey = persistedModel;
				let resolvedModelObj: ReturnType<typeof this.lookupModel> | undefined;
				let wasRestoredFallback = false;
				if (persistedModel) {
					try {
						const { provider, modelId, resolvedId } = this.resolveModel(
							persistedModel,
							this.firstAvailableModelKey() ? [this.firstAvailableModelKey()!] : [],
						);
						resolvedModelKey = resolvedId;
						resolvedModelObj = this.lookupModel(provider, modelId);
						wasRestoredFallback = resolvedId !== persistedModel;
					} catch {
						// No usable model at all (no keys configured). Keep the
						// persisted model string so the UI still shows *something*;
						// the first prompt will surface the real error.
					}
				}

				// Recalculate cumulative token usage from persisted messages.
				// pi SDK persists usage per-message in the JSONL session file,
				// so we reconstruct the agent-level total by walking all
				// assistant messages. This is the source of truth — entry.usage
				// (if present) is only used as a fallback for agents whose
				// messages happen to carry no usage data.
				const cumUsage: UsageSnapshot = { ...EMPTY_USAGE };
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
					Object.assign(cumUsage, entry.usage);
				}

				// Restore last-context-tokens from the last assistant message.
				// This seeds the context ring so it shows the correct usage
				// immediately on restart, rather than showing 0% until the
				// next message_end arrives.
				const lastAssistantWithUsage = [...uiMessages].reverse().find((m) => m.role === "assistant" && m.usage);
				if (lastAssistantWithUsage?.usage) {
					this.lastContextTokens.set(id, lastAssistantWithUsage.usage.inputTokens);
				}

				// Build agent info
				const info: AgentInfo = {
					id,
					name: entry.name ?? "Agent",
					role: entry.role ?? "custom",
					model: resolvedModelKey,
					thinkingLevel: entry.thinkingLevel ?? "medium",
					status: "idle",
					messageCount: uiMessages.length,
					createdAt: Date.now(),
					usage: cumUsage,
					fallbackModels: [],
					permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
				};

				// Rebuild live pi session from the opened session file
				const settingsManager = makeBaseSettings();

				const roleToolNames = getRoleTools(info.role); // string[] | null
				// null = "all built-in tools" (chat mode restored from disk)
				const toolNames: string[] = roleToolNames ?? [...BUILTIN_TOOL_NAMES];
				let systemPrompt = getRoleSystemPrompt(info.role);
				if (info.role === "chat") {
					const custom = this.userSettings.getAll().chatSystemPrompt;
					if (custom) systemPrompt = custom;
				}
				const customTools = this.buildCustomTools(toolNames, id);

				const resourceLoader = this.buildResourceLoader({
					systemPrompt,
					agentId: id,
				});
				await resourceLoader.reload();

				const allToolNames = resolveToolNames(roleToolNames, customTools);

				const { session } = await createAgentSession({
					cwd: this.cwd,
					authStorage: this.authStorage,
					modelRegistry: this.modelRegistry,
					sessionManager: sm,
					settingsManager,
					thinkingLevel: info.thinkingLevel,
					tools: allToolNames,
					customTools: customTools as any,
					resourceLoader,
					// Pin the resolved model so we never let pi's session
					// restore use a model the user no longer has a key for.
					...(resolvedModelObj ? { model: resolvedModelObj } : {}),
				});

				if (wasRestoredFallback) {
					this.emit({
						type: "agent:model-fallback",
						agentId: id,
						primary: persistedModel,
						resolved: resolvedModelKey,
						triedChain: [
							persistedModel,
							...(this.firstAvailableModelKey() ? [this.firstAvailableModelKey()!] : []),
						],
					});
				}

				const managed: ManagedAgent = {
					info,
					session,
					messages: uiMessages,
					unsubscribe: session.subscribe((event) => this.handleSessionEvent(id, event)),
					permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
				};

				this.agents.set(id, managed);
				this.agentUsage.set(id, { ...cumUsage });
				loaded++;
			}

			if (loaded > 0) {
				console.log(`[Look] Restored ${loaded} agent(s) from ~/.look/`);
				this.emitAgentList();
			}
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
	 * Self-test an env-var credential for a provider. Reads the
	 * env var and runs the same probe as testApiKey.
	 */
	async testEnvKey(provider: string) {
		const { findEnvKeys } = await import("@earendil-works/pi-ai");
		const { testApiKey } = await import("./provider-validator.js");
		const envVar = findEnvKeys(provider)?.[0];
		if (!envVar) return { skipped: true, reason: `No env var known for "${provider}"` };
		const key = process.env[envVar];
		if (!key) return { skipped: true, reason: `${envVar} is not set` };
		return testApiKey(provider, key);
	}

	/** Return provider IDs whose env-var credential is available. */
	async getVerifiedEnvProviders(): Promise<string[]> {
		const { findEnvKeys } = await import("@earendil-works/pi-ai");
		const allModels = this.modelRegistry.getAll();
		const seen = new Set<string>();
		const providers: string[] = [];
		for (const m of allModels) {
			if (seen.has(m.provider)) continue;
			seen.add(m.provider);
			const status = this.authStorage.getAuthStatus(m.provider);
			if (status.source !== "environment") continue;
			const envVar = findEnvKeys(m.provider)?.[0];
			if (!envVar || !process.env[envVar]) continue;
			providers.push(m.provider);
		}
		return providers;
	}

	private isUserConfigured(provider: string): boolean {
		return this.authStorage.getAuthStatus(provider).source === "stored";
	}

	/** Returns the project root directory path. */
	getProjectRoot(): string {
		return this.cwd;
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
			.getAll()
			.filter((m) => this.isUserConfigured(m.provider))
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

	/** First user-configured model key as `provider/id`, or null. */
	firstAvailableModelKey(): string | null {
		const models = this.getAvailableModelsSync();
		if (models.length === 0) return null;
		return `${models[0].provider}/${models[0].id}`;
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
				providerMap.set(m.provider, { name: m.provider, models: [] });
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
		return providers.map((p) => {
			const s = this.authStorage.getAuthStatus(p.id);
			return {
				id: p.id,
				name: p.name,
				hasKey: p.hasCredentials,
				envVar: envVarForProvider(p.id),
				modelsAvailable: p.models.length,
				authSource: s.source,
				envLabel: s.label,
			};
		});
	}

	getGeneralSettings(): UserSettings {
		return this.userSettings.getAll();
	}
	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		return this.userSettings.update(partial);
	}
	async resetGeneralSettings(): Promise<UserSettings> {
		return this.userSettings.reset();
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
		const loaded = listAllSkills(this.cwd);
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
		const skill = findSkill(this.cwd, skillName);
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
	 * Add one or more `skillPaths` to `~/.look/settings.json.skills`.
	 * Used by the renderer's "Import from <tool>" affordance to make
	 * Claude Code / Cursor / Codex / Copilot skills available in Look.
	 *
	 * We write the file directly because the SDK's `SettingsManager`
	 * doesn't expose a setter for the `skills` field — the field is
	 * consumed by `DefaultResourceLoader` but only via the loaded
	 * JSON, not as a typed property.
	 */
	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const settingsPath = join(getLookDir(), "settings.json");
			let raw: Record<string, unknown> = {};
			if (fs.existsSync(settingsPath)) {
				try {
					raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
				} catch {
					raw = {};
				}
			}
			const existing = Array.isArray(raw.skills) ? (raw.skills as unknown[]) : [];
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
			raw.skills = merged;
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
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

	// Internal: read the `skills` array from settings.json for the
	// `listSkillsForUI` snapshot. SettingsManager doesn't expose a
	// typed getter, so we read the file directly.
	private readImportedSkillPaths(): string[] {
		try {
			const settingsPath = path.join(getLookDir(), "settings.json");
			if (!fs.existsSync(settingsPath)) return [];
			const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			return Array.isArray(raw.skills) ? (raw.skills as string[]) : [];
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
	private resolveModel(primaryModelId: string, fallbackModelIds: string[]) {
		for (const c of [primaryModelId, ...fallbackModelIds]) {
			const [p, ...parts] = c.includes("/") ? c.split("/") : ["anthropic", c];
			if (!this.isUserConfigured(p)) continue;
			const found = this.lookupModel(p, parts.join("/"));
			if (found) return { provider: p, modelId: parts.join("/"), resolvedId: c };
		}
		throw new Error(
			`No usable model found. Tried: [${[primaryModelId, ...fallbackModelIds].join(", ")}]. ` +
				`Set an API key in Settings, or pass a configured model explicitly.`,
		);
	}

	private lookupModel(provider: string, modelId: string) {
		return this.modelRegistry.find(provider, modelId) ?? getModel(provider as any, modelId);
	}

	// ============================================================
	// Context Usage & Compression
	// ============================================================

	getContextUsage(agentId: string): ContextUsageInfo | undefined {
		const m = this.agents.get(agentId);
		if (!m) return undefined;
		let cw = 128000;

		// Context window from the model registry.
		// For providers not in pi SDK's built-in registry (e.g.
		// deepseek), the user can add a custom model entry to
		// ~/.look/models.json via the Settings UI.
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

	async createAgent(options: CreateAgentOptions): Promise<string> {
		const defaults = getRoleDefaults(options.role);
		const parentAgent = options.parentAgentId ? this.agents.get(options.parentAgentId)?.info : undefined;
		const userDef = this.userSettings.getAll().defaultThinkingLevel;
		const thinkingLevel = options.thinkingLevel ?? parentAgent?.thinkingLevel ?? userDef ?? defaults.thinkingLevel;

		// ---- Resolve primary model ----
		// Priority: explicit option > parent's model > role default >
		// first user-configured model. Chat mode has role default null,
		// so the last fallback kicks in for that role.
		const roleDefault = defaults.model; // string | null
		const primaryModelId = options.model ?? parentAgent?.model ?? roleDefault ?? this.firstAvailableModelKey();
		if (!primaryModelId) {
			throw new Error(
				`No model available for new agent. Configure an API key in Settings, or pass an explicit model.`,
			);
		}

		// ---- Resolve fallback chain ----
		// Order:
		//   1. Role static fallbacks (kept for backward compat — coder,
		//      orchestrator, etc. have meaningful role-presets).
		//   2. The full set of user-configured models (any provider the
		//      user has a key for), excluding the primary. This is what
		//      makes chat agents robust to "I only have a deepseek key"
		//      — the chain doesn't reference unconfigured anthropic /
		//      openai models the role happened to hard-code.
		//   3. firstAvailableModelKey() as the absolute last resort,
		//      guarded by the resolveModel's isUserConfigured check.
		// resolveModel itself further filters out unconfigured entries
		// so a stale primary/fallback can't crash the session.
		const roleFallbacks = options.fallbackModels ?? defaults.fallbackModels ?? [];
		const dynamicFallbacks = this.getAvailableModelsSync()
			.map((m) => `${m.provider}/${m.id}`)
			.filter((key) => key !== primaryModelId && !roleFallbacks.includes(key));
		const lastResort = this.firstAvailableModelKey();
		const lastResortFiltered =
			lastResort && lastResort !== primaryModelId && !roleFallbacks.includes(lastResort) ? [lastResort] : [];
		const fallbackModels = [...roleFallbacks, ...dynamicFallbacks, ...lastResortFiltered];

		const { provider, modelId, resolvedId } = this.resolveModel(primaryModelId, fallbackModels);
		const wasFallback = resolvedId !== primaryModelId;

		const id = uuidv4().slice(0, 8);
		const roleToolNames = getRoleTools(options.role); // string[] | null
		// null = "all built-in tools" (chat mode)
		const toolNames: string[] = roleToolNames ?? ["read", "bash", "write", "edit", "grep", "find", "ls"];
		const model = this.lookupModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${resolvedId}`);

		const customTools = this.buildCustomTools(toolNames, id);
		let systemPrompt = getRoleSystemPrompt(options.role);
		if (options.role === "chat") {
			const custom = this.userSettings.getAll().chatSystemPrompt;
			if (custom) systemPrompt = custom;
		}
		const resourceLoader = this.buildResourceLoader({
			systemPrompt,
			agentId: id,
		});
		await resourceLoader.reload();

		// pi native persistence: SessionManager.create writes to ~/.look/sessions/
		const sm = SessionManager.create(this.cwd, getSessionsDir());
		// Intentional: a brand-new agent with no messages is NOT a
		// valid conversation. We deliberately do NOT seed an empty
		// session.jsonl here — the SDK's lazy-flush means the file
		// is only created on disk after the first assistant message
		// lands, and `loadPersistedAgents` skips agents whose
		// sessionFile doesn't exist on restart. So a "create then
		// close before any message" agent will be pruned from the
		// index on next start. (The sessionFile path is still saved
		// into `agents.json` immediately so the agent's in-memory
		// session is recoverable as soon as the first message lands.)
		const settingsManager = makeBaseSettings();

		const allToolNames = resolveToolNames(roleToolNames, customTools);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: this.cwd,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			model,
			thinkingLevel,
			tools: allToolNames,
			customTools: customTools as any,
			resourceLoader,
			sessionManager: sm,
			settingsManager,
		});

		this.agentUsage.set(id, { ...EMPTY_USAGE });

		const info: AgentInfo = {
			id,
			name: options.name,
			role: options.role,
			model: resolvedId,
			thinkingLevel,
			status: "idle",
			messageCount: 0,
			createdAt: Date.now(),
			usage: { ...EMPTY_USAGE },
			fallbackModels,
			permissionMode: "ask",
		};

		const managed: ManagedAgent = {
			info,
			session,
			messages: [],
			unsubscribe: session.subscribe((e) => this.handleSessionEvent(id, e)),
			permissionMode: "ask",
		};
		this.agents.set(id, managed);

		const fallbackNote = wasFallback ? ` (fallback to ${resolvedId})` : "";
		const modelWarn = modelFallbackMessage ? ` [⚠ ${modelFallbackMessage}]` : "";
		this.addMessage(id, {
			id: uuidv4(),
			agentId: id,
			role: "system",
			content: `Agent "${options.name}" [${options.role}] started. Model: ${resolvedId}, Thinking: ${thinkingLevel}${fallbackNote}${modelWarn}`,
			timestamp: Date.now(),
		});

		// Product decision: a brand-new agent with no messages is NOT
		// a valid conversation. We deliberately do NOT write
		// `agents.json` here — committing the agent to the index
		// happens on the first `message_end` event below. If the user
		// closes the app before sending any message, the in-memory
		// `ManagedAgent` is simply discarded along with the renderer
		// state, and `loadPersistedAgents` never sees a record.
		this.emit({ type: "agent:created", agentId: id, agent: { ...info } });
		// P-未5: surface the fallback switch in the UI. The renderer
		// uses this to show a toast (e.g. "primary 'claude-sonnet-4'
		// unavailable, using 'deepseek/deepseek-v4-pro'"). Keeping the
		// tried chain in the event lets the UI show a small "details"
		// affordance later if we want to.
		if (wasFallback) {
			this.emit({
				type: "agent:model-fallback",
				agentId: id,
				primary: primaryModelId,
				resolved: resolvedId,
				triedChain: [primaryModelId, ...fallbackModels],
			});
		}
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
		this.lastCompactPct.delete(agentId);
		this.saveIndex();
		this.emit({ type: "agent:destroyed", agentId });
		this.emitAgentList();
	}

	getAgentInfo(agentId: string) {
		return this.agents.get(agentId)?.info;
	}
	listAgents() {
		return Array.from(this.agents.values()).map((a) => ({ ...a.info }));
	}

	/**
	 * Snapshot of agents + each agent's restored history, returned in a
	 * single IPC roundtrip. This is the primary path for the renderer to
	 * bootstrap its state on mount: avoids the race where a separate
	 * `getHistory` pull happens before `loadPersistedAgents` has finished
	 * landing the agent in `this.agents`, or after a StrictMode double-
	 * mount has discarded the result.
	 */
	listAgentsWithHistory(): { agents: AgentInfo[]; history: Record<string, AgentMessage[]> } {
		const agents = this.listAgents();
		const history: Record<string, AgentMessage[]> = {};
		for (const a of this.agents.values()) {
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

	async askAgent(agentId: string, question: string, timeoutMs: number): Promise<string> {
		const m = this.agents.get(agentId);
		if (!m) throw new Error(`Agent ${agentId} not found`);
		return new Promise<string>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`Timeout asking agent ${agentId}`)), timeoutMs);
			(m.resolveWaits ??= []).push(() => {
				clearTimeout(t);
				const last = [...m.messages].reverse().find((x) => x.role === "assistant");
				resolve(last?.content ?? "(no response)");
			});
			this.sendMessage(agentId, question);
		});
	}

	async waitForAgent(agentId: string, timeoutMs: number): Promise<void> {
		const m = this.agents.get(agentId);
		if (!m) throw new Error(`Agent ${agentId} not found`);
		if (m.info.status === "idle") return;
		return new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`Timeout waiting for agent ${agentId}`)), timeoutMs);
			(m.resolveWaits ??= []).push(() => {
				clearTimeout(t);
				resolve();
			});
		});
	}

	// ============================================================
	// Thinking Level
	// ============================================================

	setThinkingLevel(agentId: string, level: ThinkingLevel): void {
		const m = this.agents.get(agentId);
		if (!m) return;
		m.session.setThinkingLevel(level);
		m.info.thinkingLevel = level;
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
		if (!this.isUserConfigured(provider)) {
			throw new Error(`Provider '${provider}' is not configured. Add an API key in Settings first.`);
		}

		await m.session.setModel(model);
		m.info.model = modelKey;
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
		this.emit(this.toRendererEvent(agentId, event));
	}

	/** Convert a pi session event to a Look-namespaced renderer event. */
	private toRendererEvent(agentId: string, event: any): any {
		// Pass pi's payload fields through unchanged; just rewrite `type`
		// and inject `agentId` so the renderer can correlate.
		return { ...event, type: `agent:${event.type}`, agentId };
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
				break;
			}
			case "message_update": {
				// Mirror pi's deltas into the local message so the next
				// message_end has a complete record. We DO NOT emit a
				// separate text-delta event — the renderer reads from
				// message_update's assistantMessageEvent directly.
				const evt = event.assistantMessageEvent;
				if (!evt) break;
				const sm = [...m.messages].reverse().find((x) => x.isStreaming);
				if (!sm) break;
				if (evt.type === "text_delta") sm.content += evt.delta;
				else if (evt.type === "thinking_delta") sm.thinking = (sm.thinking ?? "") + evt.delta;
				break;
			}
			case "message_end": {
				const msg = event.message;
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
					}
				}
				if (msg?.role === "assistant" && msg.usage) this.trackUsage(agentId, msg.usage);
				m.info.messageCount = m.messages.length;

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
					tm.toolCalls = [
						...(tm.toolCalls ?? []),
						{
							callId: event.toolCallId,
							toolName: event.toolName,
							args: event.args ?? {},
							status: "running",
						},
					];
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
				// Sync final state into the local tool-call record.
				const tm = [...m.messages]
					.reverse()
					.find((x) => x.role === "assistant" && x.toolCalls?.some((t) => t.callId === event.toolCallId));
				if (tm) {
					const tc = tm.toolCalls?.find((t) => t.callId === event.toolCallId);
					if (tc) {
						tc.status = event.isError ? "error" : "success";
						tc.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
						tc.isError = event.isError;
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
				m.resolveWaits?.forEach((fn) => {
					fn();
				});
				m.resolveWaits = undefined;

				// Auto-compress after the agent loop finishes.
				// (triggering on message_end is too early — status is still
				// "thinking" so compressSession's guard returns immediately.)
				// At this point pi SDK's internal _checkCompaction has already
				// run in _handlePostAgentRun, so prepareCompaction() will
				// detect "already compacted" and skip if the SDK handled it.
				const s = this.userSettings.getAll();
				if (s.autoCompress) {
					const ctx = this.getContextUsage(agentId);
					if (ctx && ctx.percentage >= s.compressThreshold) {
						const lp = this.lastCompactPct.get(agentId);
						if (lp === undefined || lp < s.compressThreshold) {
							this.lastCompactPct.set(agentId, ctx.percentage);
							this.compressSession(agentId);
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
		const cum = this.agentUsage.get(agentId) ?? { ...EMPTY_USAGE };
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
		m.info.usage = { ...cum };
		this.emit({ type: "agent:usage-update", agentId, usage: { ...cum } });
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
	private addMessage(agentId: string, msg: AgentMessage): void {
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

	private buildCustomTools(toolNames: string[], agentId: string): any[] {
		const orch = ["spawn_agent", "send_to_agent", "ask_agent", "wait_for_agent", "list_agents"];
		return toolNames.some((t) => orch.includes(t)) ? createOrchestrationTools(this, agentId) : [];
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
		task?: TaskNode;
	}): DefaultResourceLoader {
		// v0.3 skills: feed the SDK the project's `<root>/.look/skills/`
		// directory. Combined with the SDK's `agentDir: getLookDir()`
		// default, the loader picks up both project-level and global
		// `~/.look/skills/` skills. The SDK then auto-injects them into
		// each worker's system prompt via `buildSystemPrompt` (we don't
		// need to call `formatSkillsForPrompt` ourselves — see
		// `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`).
		const projectSkillsDir = getLookProjectSkillsDir(this.cwd);
		const hasProjectSkills = existsSync(projectSkillsDir);

		// v0.3 skills scoping: when the orchestrator (v0.2, not yet
		// implemented) spawns a worker with a `task.allowedSkills`
		// constraint, narrow the visible set. The SDK's
		// `formatSkillsForPrompt` already filters out skills with
		// `disable-model-invocation: true` — we only add the optional
		// allowed-list on top.
		const allowed = opts.task?.allowedSkills;
		const skillsOverride =
			allowed === undefined
				? undefined
				: (result: { skills: Array<{ name: string }>; diagnostics: unknown[] }) => {
						const allow = new Set(allowed);
						return {
							...result,
							skills: result.skills.filter((s) => allow.has(s.name)),
						};
					};
		// SDK's skillsOverride signature uses the SDK's own Skill and
		// ResourceDiagnostic types; we use a narrow in-house shape and
		// cast to satisfy the SDK option type. Runtime contract is
		// preserved: we only filter `skills` by name and forward
		// `diagnostics` unchanged.
		const skillsOverrideForSdk = skillsOverride as any;

		return new DefaultResourceLoader({
			cwd: this.cwd,
			// Resource discovery (extensions / skills / prompts / themes /
			// context files) lives under `~/.look/` so it lines up with
			// our AuthStorage / ModelRegistry / SessionManager paths.
			// The SDK default `getAgentDir()` would point at the global
			// `~/.pi/agent/`, which is what the `pi` CLI uses — we don't
			// want to inherit that scope.
			agentDir: getLookDir(),
			// v0.3: feed project-level skills into the SDK's loader so
			// they get auto-injected into worker system prompts.
			...(hasProjectSkills ? { additionalSkillPaths: [projectSkillsDir] } : {}),
			// v0.3: optional allowed-list for orchestrator-spawned workers.
			...(skillsOverrideForSdk ? { skillsOverride: skillsOverrideForSdk } : {}),
			systemPromptOverride: () => opts.systemPrompt,
			extensionFactories: [
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
