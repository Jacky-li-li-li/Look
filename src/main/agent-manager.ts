// ============================================================
// AgentManager — Multi-Agent Orchestration Core
//
// Persistence: pi SessionManager manages session .jsonl files natively
// (create/open/auto-save). We only store a lightweight agents.json index
// mapping agentId → sessionFile.
// ============================================================

import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import {
  ensureLookDir,
  getAgentsIndexPath,
  getSessionsDir,
  getAuthPath,
  getModelsPath,
} from "./shared/look-storage.js";
import { convertPiMessage } from "./shared/message-convert.js";
import type {
  AgentInfo,
  AgentStatus,
  AgentRole,
  ThinkingLevel,
  AgentMessage,
  ToolCallRecord,
  MainToRendererEvent,
  UsageSnapshot,
  PermissionMode,
  ContextUsageInfo,
} from "./shared/types.js";
import {
  ROLE_CONFIGS,
  getRoleTools,
  getRoleSystemPrompt,
  getRoleDefaults,
} from "./agents/roles.js";
import { createOrchestrationTools } from "./tools/orchestration.js";
import { checkPermission } from "./permissions/permission-gate.js";
import { PermissionAskService, type PermissionAskRequest } from "./permissions/permission-ask.js";
import { UserSettingsStore, type UserSettings } from "./user-settings.js";

/** Tools allowed in "plan" mode. Anything else is hard-blocked. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

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

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  huggingface: "HF_TOKEN",
  vercel: "AI_GATEWAY_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  zai: "ZAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
};

const EMPTY_USAGE: UsageSnapshot = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
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
    this.authStorage = AuthStorage.create(getAuthPath());
    this.modelRegistry = ModelRegistry.create(this.authStorage, getModelsPath());
    this.userSettings = new UserSettingsStore();
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
          if (msg.role === "bashExecution" || msg.role === "custom" ||
              msg.role === "branchSummary" || msg.role === "compactionSummary") continue;
          uiMessages.push(convertPiMessage(msg, id, e.id));
        }

        // Build agent info
        const info: AgentInfo = {
          id,
          name: entry.name ?? "Agent",
          role: entry.role ?? "custom",
          model: entry.model ?? "",
          thinkingLevel: entry.thinkingLevel ?? "medium",
          status: "idle",
          messageCount: uiMessages.length,
          createdAt: Date.now(),
          usage: { ...EMPTY_USAGE },
          fallbackModels: [],
          permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
        };

        // Rebuild live pi session from the opened session file
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 30000 },
          retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
        });

        const roleToolNames = getRoleTools(info.role);  // string[] | null
        // null = "all built-in tools" (chat mode restored from disk)
        const toolNames: string[] = roleToolNames ?? ["read", "bash", "write", "edit", "grep", "find", "ls"];
        const systemPrompt = getRoleSystemPrompt(info.role);
        const customTools = this.buildCustomTools(toolNames, id);

        const resourceLoader = this.buildResourceLoader({
          systemPrompt,
          agentId: id,
        });
        await resourceLoader.reload();

        const builtinNames = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);
        const allToolNames = [
          ...toolNames.filter(t => builtinNames.has(t)),
          ...customTools.map((t: any) => t.name),
        ];

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
        });

        const managed: ManagedAgent = {
          info,
          session,
          messages: uiMessages,
          unsubscribe: session.subscribe((event) => this.handleSessionEvent(id, event)),
          permissionMode: (entry.permissionMode as PermissionMode) ?? "ask",
        };

        this.agents.set(id, managed);
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
    if (!trimmed) { this.authStorage.remove(provider); }
    else { this.authStorage.set(provider, { type: "api_key", key: trimmed }); }
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

  private isUserConfigured(provider: string): boolean {
    return this.authStorage.getAuthStatus(provider).source === "stored";
  }

  /**
   * Synchronous accessor for the user-configured model set. Used by
   * the createAgent path (which is async but wants to derive the
   * first-available model before yielding to the modelRegistry).
   */
  getAvailableModelsSync(): Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }> {
    return this.modelRegistry.getAll()
      .filter(m => this.isUserConfigured(m.provider))
      .map(m => ({
        provider: m.provider, id: m.id, name: m.name ?? m.id,
        reasoning: m.reasoning ?? false, contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 16384, cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
      }));
  }

  /** First user-configured model key as `provider/id`, or null. */
  firstAvailableModelKey(): string | null {
    const models = this.getAvailableModelsSync();
    if (models.length === 0) return null;
    return `${models[0].provider}/${models[0].id}`;
  }

  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }>> {
    return this.getAvailableModelsSync();
  }

  async getProviders(): Promise<Array<{ id: string; name: string; hasCredentials: boolean; models: string[] }>> {
    const allModels = this.modelRegistry.getAll();
    const providerMap = new Map<string, { name: string; models: string[] }>();
    for (const m of allModels) {
      const e = providerMap.get(m.provider);
      if (e) { e.models.push(m.id); }
      else { providerMap.set(m.provider, { name: m.provider, models: [m.id] }); }
    }
    for (const id of Object.keys(PROVIDER_ENV_VARS)) {
      if (!providerMap.has(id)) providerMap.set(id, { name: id, models: [] });
    }
    return Array.from(providerMap.entries()).map(([id, info]) => ({
      id, name: info.name,
      hasCredentials: this.isUserConfigured(id),
      models: this.isUserConfigured(id) ? info.models : [],
    }));
  }

  async getProviderSettings() {
    const providers = await this.getProviders();
    return providers.map(p => {
      const s = this.authStorage.getAuthStatus(p.id);
      return {
        id: p.id, name: p.name, hasKey: p.hasCredentials,
        envVar: PROVIDER_ENV_VARS[p.id] ?? `${p.id.toUpperCase()}_API_KEY`,
        modelsAvailable: p.models.length, authSource: s.source, envLabel: s.label,
      };
    });
  }

  getGeneralSettings(): UserSettings { return this.userSettings.getAll(); }
  updateGeneralSettings(partial: Partial<UserSettings>): UserSettings { return this.userSettings.update(partial); }
  resetGeneralSettings(): UserSettings { return this.userSettings.reset(); }

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
    const ms = m.info.model;
    if (ms) {
      const [p, ...parts] = ms.includes("/") ? ms.split("/") : ["anthropic", ms];
      const mdl = this.lookupModel(p, parts.join("/"));
      if (mdl?.contextWindow) cw = mdl.contextWindow;
    }
    const used = this.lastContextTokens.get(agentId) ?? 0;
    const pct = Math.min(100, Math.round((used / cw) * 100));
    return { percentage: pct, usedTokens: used, totalTokens: cw, level: pct >= 80 ? "critical" : pct >= 60 ? "warning" : "safe", compacting: false };
  }

  async compressSession(agentId: string): Promise<void> {
    const m = this.agents.get(agentId);
    if (!m || m.info.status === "thinking" || m.info.status === "working") return;
    // `agent:compacting` is emitted from the `compaction_start` /
    // `compaction_end` side-effect handler, not here — avoids a
    // double-emit race.
    try { await m.session.compact(); } catch {}
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
    const roleDefault = defaults.model;          // string | null
    const primaryModelId = options.model
      ?? parentAgent?.model
      ?? roleDefault
      ?? this.firstAvailableModelKey();
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
      .map(m => `${m.provider}/${m.id}`)
      .filter(key => key !== primaryModelId && !roleFallbacks.includes(key));
    const lastResort = this.firstAvailableModelKey();
    const lastResortFiltered = lastResort && lastResort !== primaryModelId && !roleFallbacks.includes(lastResort)
      ? [lastResort]
      : [];
    const fallbackModels = [...roleFallbacks, ...dynamicFallbacks, ...lastResortFiltered];

    const { provider, modelId, resolvedId } = this.resolveModel(primaryModelId, fallbackModels);
    const wasFallback = resolvedId !== primaryModelId;

    const id = uuidv4().slice(0, 8);
    const roleToolNames = getRoleTools(options.role);  // string[] | null
    // null = "all built-in tools" (chat mode)
    const toolNames: string[] = roleToolNames ?? ["read", "bash", "write", "edit", "grep", "find", "ls"];
    const model = this.lookupModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedId}`);

    const customTools = this.buildCustomTools(toolNames, id);
    const resourceLoader = this.buildResourceLoader({
      systemPrompt: getRoleSystemPrompt(options.role),
      agentId: id,
    });
    await resourceLoader.reload();

    // pi native persistence: SessionManager.create writes to ~/.look/sessions/
    const sm = SessionManager.create(this.cwd, getSessionsDir());
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 30000 },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    });

    const builtinNames = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);
    const allToolNames = [
      ...toolNames.filter(t => builtinNames.has(t)),
      ...customTools.map((t: any) => t.name),
    ];

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd, authStorage: this.authStorage, modelRegistry: this.modelRegistry,
      model, thinkingLevel, tools: allToolNames, customTools: customTools as any,
      resourceLoader, sessionManager: sm, settingsManager,
    });

    this.agentUsage.set(id, { ...EMPTY_USAGE });

    const info: AgentInfo = {
      id, name: options.name, role: options.role, model: resolvedId,
      thinkingLevel, status: "idle", messageCount: 0, createdAt: Date.now(),
      usage: { ...EMPTY_USAGE }, fallbackModels,
      permissionMode: "ask",
    };

    const managed: ManagedAgent = {
      info, session, messages: [],
      unsubscribe: session.subscribe((e) => this.handleSessionEvent(id, e)),
      permissionMode: "ask",
    };
    this.agents.set(id, managed);

    const fallbackNote = wasFallback ? ` (fallback to ${resolvedId})` : "";
    const modelWarn = modelFallbackMessage ? ` [⚠ ${modelFallbackMessage}]` : "";
    this.addMessage(id, {
      id: uuidv4(), agentId: id, role: "system",
      content: `Agent "${options.name}" [${options.role}] started. Model: ${resolvedId}, Thinking: ${thinkingLevel}${fallbackNote}${modelWarn}`,
      timestamp: Date.now(),
    });

    this.saveIndex();
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
    try { m.session.dispose(); } catch {}
    this.agents.delete(agentId);
    this.agentUsage.delete(agentId);
    this.lastContextTokens.delete(agentId);
    this.lastCompactPct.delete(agentId);
    this.saveIndex();
    this.emit({ type: "agent:destroyed", agentId });
    this.emitAgentList();
  }

  getAgentInfo(agentId: string) { return this.agents.get(agentId)?.info; }
  listAgents() { return Array.from(this.agents.values()).map(a => ({ ...a.info })); }

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
  getMessages(agentId: string) { return this.agents.get(agentId)?.messages ?? []; }

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
    if (!m) { this.emit({ type: "error", agentId, message: `Agent ${agentId} not found` }); return; }
    this.updateStatus(agentId, "thinking");
    const userMsg: AgentMessage = {
      id: uuidv4(), agentId, role: "user",
      content: fromAgentId ? `[@${fromAgentId}] ${text}` : text, timestamp: Date.now(),
    };
    this.addMessage(agentId, userMsg);
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
      if (em) { this.emit({ type: "error", agentId, message: `Agent error: ${em}` }); this.updateStatus(agentId, "error"); }
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
    if (!m.session.isStreaming) return;  // nothing to abort
    try {
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
      (m.resolveWaits ??= []).push(() => { clearTimeout(t); const last = [...m.messages].reverse().find(x => x.role === "assistant"); resolve(last?.content ?? "(no response)"); });
      this.sendMessage(agentId, question);
    });
  }

  async waitForAgent(agentId: string, timeoutMs: number): Promise<void> {
    const m = this.agents.get(agentId);
    if (!m) throw new Error(`Agent ${agentId} not found`);
    if (m.info.status === "idle") return;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for agent ${agentId}`)), timeoutMs);
      (m.resolveWaits ??= []).push(() => { clearTimeout(t); resolve(); });
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

    const [provider, ...idParts] = modelKey.includes("/")
      ? modelKey.split("/")
      : ["anthropic", modelKey];
    const modelId = idParts.join("/");
    const model = this.lookupModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${modelKey}`);

    // Pre-flight: the SDK will throw on its own (auth lookup) but
    // the error is opaque ("no credentials" deep in pi internals).
    // Catching it here gives the renderer a clean message it can
    // surface in a toast and roll the model selector back.
    if (!this.isUserConfigured(provider)) {
      throw new Error(
        `Provider '${provider}' is not configured. Add an API key in Settings first.`,
      );
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
        // Persist a streaming placeholder for assistant messages so
        // the renderer can render incrementally without a second
        // message_start for user/tool messages.
        if (event.message?.role === "assistant") {
          this.addMessage(agentId, {
            id: uuidv4(), agentId, role: "assistant", content: "", thinking: "",
            timestamp: Date.now(), isStreaming: true, toolCalls: [],
          });
        }
        break;
      }
      case "message_update": {
        // Mirror pi's deltas into the local message so the next
        // message_end has a complete record. We DO NOT emit a
        // separate text-delta event — the renderer reads from
        // message_update's assistantMessageEvent directly.
        const evt = event.assistantMessageEvent; if (!evt) break;
        const sm = [...m.messages].reverse().find(x => x.isStreaming); if (!sm) break;
        if (evt.type === "text_delta") sm.content += evt.delta;
        else if (evt.type === "thinking_delta") sm.thinking = (sm.thinking ?? "") + evt.delta;
        break;
      }
      case "message_end": {
        const msg = event.message;
        const sm = [...m.messages].reverse().find(x => x.isStreaming);
        if (sm) sm.isStreaming = false;
        if (msg?.role === "assistant" && msg.usage) this.trackUsage(agentId, msg.usage);
        m.info.messageCount = m.messages.length;
        this.saveIndex();

        // Context ring + auto-compact (Look-specific)
        const ctx = this.getContextUsage(agentId);
        if (ctx) this.emit({ type: "agent:context-usage", agentId, usage: ctx });
        const s = this.userSettings.getAll();
        if (s.autoCompress && ctx && ctx.percentage >= s.compressThreshold) {
          const lp = this.lastCompactPct.get(agentId);
          if (lp === undefined || lp < s.compressThreshold) {
            this.lastCompactPct.set(agentId, ctx.percentage);
            this.compressSession(agentId);
          }
        }
        break;
      }
      case "tool_execution_start": {
        // Track tool call in the local message AND enforce permission gate.
        this.updateStatus(agentId, "working");
        const tm = [...m.messages].reverse().find(x => x.isStreaming && x.role === "assistant")
          ?? [...m.messages].reverse().find(x => x.role === "assistant");
        if (tm) {
          tm.toolCalls = [...(tm.toolCalls ?? []), {
            callId: event.toolCallId, toolName: event.toolName,
            args: event.args ?? {}, status: "running",
          }];
        }
        const perm = checkPermission(event.toolName, event.args ?? {}, m.info.role);
        if (perm.action === "deny") {
          // Mark for skip in pass-through; the synthetic tool-end is
          // emitted here so the renderer still sees the failure.
          // Note: real pre-execution blocking happens in the
          // extensionFactory's `tool_call` hook. This is a
          // belt-and-suspenders fallback in case the extension
          // didn't fire.
          (this.blockedToolCalls.get(agentId) ?? this.blockedToolCalls.set(agentId, new Set()).get(agentId)!)
            .add(event.toolCallId);
          this.emit({
            type: "agent:tool_execution_end",
            agentId,
            toolCallId: event.toolCallId, toolName: event.toolName,
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
        const tm = [...m.messages].reverse().find(x => x.role === "assistant" && x.toolCalls?.some(t => t.callId === event.toolCallId));
        if (tm) {
          const tc = tm.toolCalls?.find(t => t.callId === event.toolCallId);
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
        m.resolveWaits?.forEach(fn => fn());
        m.resolveWaits = undefined;
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
    const m = this.agents.get(agentId); if (!m) return;
    this.lastContextTokens.set(agentId, usage.input ?? 0);
    const snap: UsageSnapshot = {
      inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cost: { input: usage.cost?.input ?? 0, output: usage.cost?.output ?? 0, cacheRead: usage.cost?.cacheRead ?? 0, cacheWrite: usage.cost?.cacheWrite ?? 0, total: usage.cost?.total ?? 0 },
    };
    const cum = this.agentUsage.get(agentId) ?? { ...EMPTY_USAGE };
    cum.inputTokens += snap.inputTokens; cum.outputTokens += snap.outputTokens;
    cum.cacheReadTokens += snap.cacheReadTokens; cum.cacheWriteTokens += snap.cacheWriteTokens;
    cum.totalTokens += snap.totalTokens;
    cum.cost.input += snap.cost.input; cum.cost.output += snap.cost.output;
    cum.cost.cacheRead += snap.cost.cacheRead; cum.cost.cacheWrite += snap.cost.cacheWrite;
    cum.cost.total += snap.cost.total;
    this.agentUsage.set(agentId, cum);
    m.info.usage = { ...cum };
    this.emit({ type: "agent:usage-update", agentId, usage: { ...cum } });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private updateStatus(agentId: string, status: AgentStatus): void {
    const m = this.agents.get(agentId); if (!m) return;
    m.info.status = status; this.emit({ type: "agent:status", agentId, status });
  }

  /**
   * Append a message to an agent's local store and (for assistant
   * role) emit `agent:message_start` so the renderer can render
   * the streaming placeholder. We mirror pi's `message_start` event
   * here instead of inventing a Look-only `agent:message` event.
   */
  private addMessage(agentId: string, msg: AgentMessage): void {
    const m = this.agents.get(agentId); if (!m) return;
    m.messages.push(msg);
    m.info.messageCount = m.messages.length;
    // For assistant messages, emit a pass-through event so the
    // renderer can pick up the streaming placeholder. Other roles
    // (user / tool / system) don't go through the message_start
    // pipeline; they're appended directly to the UI store by
    // other code paths (sendMessage, tool result handler, etc.).
    if (msg.role === "assistant") {
      this.emit({
        type: "agent:message_start",
        agentId,
        message: msg as any, // pi's AgentMessage is a superset of UI shape
      });
    }
  }

  private emitAgentList(): void { this.emit({ type: "agent:list", agentId: "", agents: this.listAgents() }); }

  onEvent(cb: EventCallback): () => void {
    this.eventCallbacks.push(cb);
    return () => { this.eventCallbacks = this.eventCallbacks.filter(c => c !== cb); };
  }

  private emit(event: MainToRendererEvent) {
    for (const cb of this.eventCallbacks) { try { cb(event); } catch {} }
  }

  private buildCustomTools(toolNames: string[], agentId: string): any[] {
    const orch = ["spawn_agent", "send_to_agent", "ask_agent", "wait_for_agent", "list_agents"];
    return toolNames.some(t => orch.includes(t)) ? createOrchestrationTools(this, agentId) : [];
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

  private buildResourceLoader(opts: { systemPrompt: string; agentId: string }): DefaultResourceLoader {
    return new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
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
