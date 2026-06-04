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
import { UserSettingsStore, type UserSettings } from "./user-settings.js";

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
        const entries = sm.getEntries();
        const uiMessages: AgentMessage[] = [];
        for (const e of entries) {
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
        };

        // Rebuild live pi session from the opened session file
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 30000 },
          retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
        });

        const toolNames = getRoleTools(info.role);
        const systemPrompt = getRoleSystemPrompt(info.role);
        const customTools = this.buildCustomTools(toolNames, id);

        const resourceLoader = new DefaultResourceLoader({
          cwd: this.cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => systemPrompt,
        });
        await resourceLoader.reload();

        const builtinNames = ["read", "bash", "write", "edit", "grep", "find", "ls"];
        const allToolNames = [
          ...toolNames.filter(t => builtinNames.includes(t)),
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

  private isUserConfigured(provider: string): boolean {
    return this.authStorage.getAuthStatus(provider).source === "stored";
  }

  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }>> {
    return this.modelRegistry.getAll()
      .filter(m => this.isUserConfigured(m.provider))
      .map(m => ({
        provider: m.provider, id: m.id, name: m.name ?? m.id,
        reasoning: m.reasoning ?? false, contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 16384, cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
      }));
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

  private resolveModel(primaryModelId: string, fallbackModelIds: string[]) {
    for (const c of [primaryModelId, ...fallbackModelIds]) {
      const [p, ...parts] = c.includes("/") ? c.split("/") : ["anthropic", c];
      const found = this.lookupModel(p, parts.join("/"));
      if (found) return { provider: p, modelId: parts.join("/"), resolvedId: c };
    }
    throw new Error(`No model found. Tried: ${[primaryModelId, ...fallbackModelIds].join(", ")}. Set an API key first.`);
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
    this.emit({ type: "agent:compacting", agentId, compacting: true });
    try { await m.session.compact(); } catch {}
    this.emit({ type: "agent:compacting", agentId, compacting: false });
  }

  // ============================================================
  // Agent CRUD
  // ============================================================

  async createAgent(options: CreateAgentOptions): Promise<string> {
    const defaults = getRoleDefaults(options.role);
    const parentAgent = options.parentAgentId ? this.agents.get(options.parentAgentId)?.info : undefined;
    const userDef = this.userSettings.getAll().defaultThinkingLevel;
    const thinkingLevel = options.thinkingLevel ?? parentAgent?.thinkingLevel ?? userDef ?? defaults.thinkingLevel;
    const fallbackModels = options.fallbackModels ?? defaults.fallbackModels;
    const primaryModelId = options.model ?? parentAgent?.model ?? defaults.model;
    const { provider, modelId, resolvedId } = this.resolveModel(primaryModelId, fallbackModels);
    const wasFallback = resolvedId !== primaryModelId;

    const id = uuidv4().slice(0, 8);
    const toolNames = getRoleTools(options.role);
    const model = this.lookupModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedId}`);

    const customTools = this.buildCustomTools(toolNames, id);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd, agentDir: getAgentDir(),
      systemPromptOverride: () => getRoleSystemPrompt(options.role),
    });
    await resourceLoader.reload();

    // pi native persistence: SessionManager.create writes to ~/.look/sessions/
    const sm = SessionManager.create(this.cwd, getSessionsDir());
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 30000 },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    });

    const builtinNames = ["read", "bash", "write", "edit", "grep", "find", "ls"];
    const allToolNames = [
      ...toolNames.filter(t => builtinNames.includes(t)),
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
    };

    const managed: ManagedAgent = {
      info, session, messages: [],
      unsubscribe: session.subscribe((e) => this.handleSessionEvent(id, e)),
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
    this.emit({ type: "agent:created", agent: { ...info } });
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
  getMessages(agentId: string) { return this.agents.get(agentId)?.messages ?? []; }

  renameAgent(agentId: string, newName: string): void {
    const m = this.agents.get(agentId);
    if (!m || !newName.trim()) return;
    m.info.name = newName.trim();
    this.saveIndex();
    this.emit({ type: "agent:updated", agent: { ...m.info } });
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
      await m.session.prompt(text);
      const em = m.session.agent?.state?.errorMessage;
      if (em) { this.emit({ type: "error", agentId, message: `Agent error: ${em}` }); this.updateStatus(agentId, "error"); }
    } catch (err: any) {
      this.emit({ type: "error", agentId, message: `Prompt failed: ${err.message}` });
      this.updateStatus(agentId, "error");
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
    this.emit({ type: "agent:updated", agent: { ...m.info } });
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

    await m.session.setModel(model);
    m.info.model = modelKey;
    this.saveIndex();
    this.emit({ type: "agent:updated", agent: { ...m.info } });
  }

  // ============================================================
  // Session Event Handling
  // ============================================================

  private handleSessionEvent(agentId: string, event: any): void {
    const m = this.agents.get(agentId);
    if (!m) return;

    switch (event.type) {
      case "message_start": {
        if (event.message?.role === "assistant") {
          this.addMessage(agentId, {
            id: uuidv4(), agentId, role: "assistant", content: "", thinking: "",
            timestamp: Date.now(), isStreaming: true, toolCalls: [],
          });
        }
        break;
      }
      case "message_update": {
        const evt = event.assistantMessageEvent; if (!evt) break;
        const sm = [...m.messages].reverse().find(x => x.isStreaming); if (!sm) break;
        if (evt.type === "text_delta") {
          sm.content += evt.delta;
          this.emit({ type: "agent:message-update", agentId, messageId: sm.id, delta: evt.delta, deltaType: "text" });
        } else if (evt.type === "thinking_delta") {
          sm.thinking = (sm.thinking ?? "") + evt.delta;
          this.emit({ type: "agent:message-update", agentId, messageId: sm.id, delta: evt.delta, deltaType: "thinking" });
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        const sm = [...m.messages].reverse().find(x => x.isStreaming);
        if (sm) {
          sm.isStreaming = false;
          this.emit({ type: "agent:message-end", agentId, messageId: sm.id, content: sm.content, thinking: sm.thinking ?? "" });
        }
        if (msg?.role === "assistant" && msg.usage) this.trackUsage(agentId, msg.usage);
        m.info.messageCount = m.messages.length;
        this.saveIndex();

        // Context ring + auto-compact
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
        this.updateStatus(agentId, "working");
        const tm = [...m.messages].reverse().find(x => x.isStreaming && x.role === "assistant")
          ?? [...m.messages].reverse().find(x => x.role === "assistant");
        if (!tm) break;
        const tc: ToolCallRecord = { callId: event.toolCallId, toolName: event.toolName, args: event.args ?? {}, status: "running" };
        tm.toolCalls = [...(tm.toolCalls ?? []), tc];
        const perm = checkPermission(event.toolName, event.args ?? {}, m.info.role);
        if (perm.action === "deny") {
          tc.status = "error"; tc.result = `BLOCKED: ${perm.reason}`; tc.isError = true;
          this.emit({ type: "agent:tool-end", agentId, messageId: tm.id, callId: event.toolCallId, result: tc.result, isError: true });
          break;
        }
        if (perm.action === "ask") {
          this.emit({ type: "permission:request", requestId: event.toolCallId, agentId, toolName: event.toolName, args: event.args ?? {}, reason: perm.reason });
        }
        this.emit({ type: "agent:tool-start", agentId, messageId: tm.id, toolCall: { ...tc } });
        break;
      }
      case "tool_execution_update": {
        const sm = [...m.messages].reverse().find(x => x.isStreaming);
        if (sm) this.emit({ type: "agent:tool-update", agentId, messageId: sm.id, callId: event.toolCallId, partial: event.partialResult ?? "" });
        break;
      }
      case "tool_execution_end": {
        const tm = [...m.messages].reverse().find(x => x.role === "assistant" && x.toolCalls?.some(t => t.callId === event.toolCallId));
        if (tm) {
          const tc = tm.toolCalls?.find(t => t.callId === event.toolCallId);
          if (tc) { tc.status = event.isError ? "error" : "success"; tc.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result); tc.isError = event.isError; }
          this.emit({ type: "agent:tool-end", agentId, messageId: tm.id, callId: event.toolCallId, result: tc?.result ?? "", isError: event.isError ?? false });
        }
        break;
      }
      case "agent_end": { this.updateStatus(agentId, "idle"); m.resolveWaits?.forEach(fn => fn()); m.resolveWaits = undefined; break; }
      case "agent_start": { this.updateStatus(agentId, "thinking"); break; }
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

  private addMessage(agentId: string, msg: AgentMessage): void {
    const m = this.agents.get(agentId); if (!m) return;
    m.messages.push(msg);
    m.info.messageCount = m.messages.length;
    this.emit({ type: "agent:message", message: msg });
  }

  private emitAgentList(): void { this.emit({ type: "agent:list", agents: this.listAgents() }); }

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
}
