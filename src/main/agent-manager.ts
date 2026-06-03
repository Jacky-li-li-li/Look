// ============================================================
// AgentManager — Multi-Agent Orchestration Core
//
// Manages multiple pi AgentSessions as agents.
// Supports: multi-model, per-agent thinking level, cost tracking,
//           model fallback, API key management
// ============================================================

import { v4 as uuidv4 } from "uuid";
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
import type {
  AgentInfo,
  AgentStatus,
  AgentRole,
  ThinkingLevel,
  AgentMessage,
  ToolCallRecord,
  MainToRendererEvent,
  UsageSnapshot,
} from "./shared/types.js";
import {
  ROLE_CONFIGS,
  getRoleTools,
  getRoleSystemPrompt,
  getRoleDefaults,
} from "./agents/roles.js";
import { createOrchestrationTools } from "./tools/orchestration.js";
import { checkPermission } from "./permissions/permission-gate.js";

// ============================================================
// Types
// ============================================================

export interface CreateAgentOptions {
  name: string;
  role: AgentRole;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  fallbackModels?: string[];
  /** If set, inherit model/thinking from this parent agent when not explicitly specified */
  parentAgentId?: string;
}

interface ManagedAgent {
  info: AgentInfo;
  session: AgentSession;
  messages: AgentMessage[];
  unsubscribe: () => void;
  resolveWait?: () => void;
}

export type EventCallback = (event: MainToRendererEvent) => void;

/** Known provider env var mapping (from pi's env-api-keys.ts) */
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
  cloudflare: "CLOUDFLARE_API_KEY",
  zai: "ZAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  minimax: "MINIMAX_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
};

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
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private cwd: string;
  private activeAgentId: string | null = null;

  // Cumulative usage per agent (persists across sessions)
  private agentUsage = new Map<string, UsageSnapshot>();

  constructor(cwd?: string, authJsonPath?: string) {
    this.cwd = cwd ?? process.cwd();
    this.authStorage = AuthStorage.create(authJsonPath);
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  // ============================================================
  // Provider & Model Management
  // ============================================================

  /** Set a runtime API key (not persisted to disk) */
  setApiKey(provider: string, key: string): void {
    this.authStorage.setRuntimeApiKey(provider, key);
  }

  /** Get all available models (only those with valid API keys) */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }>> {
    const available = await this.modelRegistry.getAvailable();
    return available.map(m => ({
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 16384,
      cost: {
        input: m.cost?.input ?? 0,
        output: m.cost?.output ?? 0,
      },
    }));
  }

  /** Get all configured providers */
  async getProviders(): Promise<Array<{ id: string; name: string; hasCredentials: boolean; models: string[] }>> {
    const allModels = await this.modelRegistry.getAvailable();
    const providerMap = new Map<string, { name: string; models: string[] }>();
    for (const m of allModels) {
      const existing = providerMap.get(m.provider);
      if (existing) {
        existing.models.push(m.id);
      } else {
        providerMap.set(m.provider, { name: m.provider, models: [m.id] });
      }
    }
    // Also include providers without credentials
    for (const id of Object.keys(PROVIDER_ENV_VARS)) {
      if (!providerMap.has(id)) {
        providerMap.set(id, { name: id, models: [] });
      }
    }
    return Array.from(providerMap.entries()).map(([id, info]) => ({
      id,
      name: info.name,
      hasCredentials: info.models.length > 0,
      models: info.models,
    }));
  }

  /** Get settings for the Settings UI */
  async getProviderSettings() {
    const providers = await this.getProviders();
    return providers.map(p => ({
      id: p.id,
      name: p.name,
      hasKey: p.hasCredentials,
      envVar: PROVIDER_ENV_VARS[p.id] ?? `${p.id.toUpperCase()}_API_KEY`,
      modelsAvailable: p.models.length,
    }));
  }

  /** Resolve a model, trying primary then fallbacks */
  private resolveModel(
    primaryModelId: string,
    fallbackModelIds: string[],
  ): { provider: string; modelId: string; resolvedId: string } {
    const allCandidates = [primaryModelId, ...fallbackModelIds];

    for (const candidate of allCandidates) {
      const [provider, ...idParts] = candidate.includes("/")
        ? candidate.split("/")
        : ["anthropic", candidate];
      const modelId = idParts.join("/");

      const found = this.lookupModel(provider, modelId);
      if (found) return { provider, modelId, resolvedId: candidate };
    }

    // Nothing found — list available models for the error
    throw new Error(
      `No model found. Tried: ${allCandidates.join(", ")}. Set an API key first.`
    );
  }

  // ============================================================
  // Model Resolution (centralized `as any` for runtime provider strings)
  // ============================================================

  /** Lookup a model by provider+id across ModelRegistry (with API key) and built-in list */
  private lookupModel(provider: string, modelId: string) {
    return (this.modelRegistry as any).find(provider, modelId)
      ?? getModel(provider as any, modelId);
  }

  // ============================================================
  // Agent CRUD
  // ============================================================

  /** Create a new agent session with model fallback */
  async createAgent(options: CreateAgentOptions): Promise<string> {
    const roleConfig = ROLE_CONFIGS[options.role] ?? ROLE_CONFIGS.custom;
    const defaults = getRoleDefaults(options.role);

    // Look up parent agent for model/thinking inheritance
    const parentAgent = options.parentAgentId
      ? this.agents.get(options.parentAgentId)?.info
      : undefined;
    const parentDefaults = parentAgent ? {
      thinkingLevel: parentAgent.thinkingLevel,
    } : undefined;

    const id = uuidv4().slice(0, 8);
    const toolNames = getRoleTools(options.role);
    const systemPrompt = getRoleSystemPrompt(options.role);
    const thinkingLevel = options.thinkingLevel ?? parentDefaults?.thinkingLevel ?? defaults.thinkingLevel;
    const fallbackModels = options.fallbackModels ?? defaults.fallbackModels;

    // Model priority: explicit > parent agent > role default
    let primaryModelId = options.model;
    if (!primaryModelId) {
      // Inherit from parent agent if available, otherwise use role default
      primaryModelId = parentAgent?.model ?? defaults.model;
    }
    const { provider, modelId, resolvedId } = this.resolveModel(primaryModelId, fallbackModels);

    const wasFallback = resolvedId !== primaryModelId;

    // Get the actual Model object (from ModelRegistry or getModel)
    let model = this.lookupModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedId}`);

    // Build custom tools for this agent
    const customTools = this.buildCustomTools(toolNames, id);

    // Build ResourceLoader following pi SDK "full control" pattern (examples/sdk/12-full-control.ts)
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      // Override system prompt with role-specific prompt
      systemPromptOverride: () => systemPrompt,
    });
    await resourceLoader.reload();

    // Layer 1 — pi retry handles transient provider errors (429, 5xx, timeout)
    const sm = SessionManager.create(this.cwd);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    });

    // Per SDK docs: "If you pass tools, include each custom or extension
    // tool name you want enabled." So we pass the FULL toolNames list.
    const builtinNames = ["read", "bash", "write", "edit", "grep", "find", "ls"];
    const customToolNames = customTools.map((t: any) => t.name);
    const allToolNames = [
      ...toolNames.filter(t => builtinNames.includes(t)),   // enabled built-in
      ...customToolNames,                                     // enabled custom
    ];

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      // Use ModelRegistry.create() (loads models.json) for custom provider support
      // Alternatives: ModelRegistry.inMemory(authStorage) for no models.json
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel,
      tools: allToolNames,
      customTools: customTools as any,
      resourceLoader,
      sessionManager: sm,
      settingsManager,
    });

    // Initialize usage tracking
    this.agentUsage.set(id, { ...EMPTY_USAGE });

    // Build agent info
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
    };

    // Managed agent
    const managed: ManagedAgent = {
      info,
      session,
      messages: [],
      unsubscribe: () => {},
    };

    const unsub = session.subscribe((event) => {
      this.handleSessionEvent(id, event);
    });
    managed.unsubscribe = unsub;

    this.agents.set(id, managed);

    // System message
    const fallbackNote = wasFallback
      ? ` (fallback: primary model ${primaryModelId} was unavailable, using ${resolvedId})`
      : "";
    const modelWarning = modelFallbackMessage ? ` [⚠ ${modelFallbackMessage}]` : "";

    this.addMessage(id, {
      id: uuidv4(),
      agentId: id,
      role: "system",
      content: `Agent "${options.name}" [${options.role}] started. Model: ${resolvedId}, Thinking: ${thinkingLevel}${fallbackNote}${modelWarning}`,
      timestamp: Date.now(),
    });

    this.emit({ type: "agent:created", agent: { ...info } });
    this.emitAgentList();

    return id;
  }

  /** Destroy an agent */
  async destroyAgent(agentId: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    managed.unsubscribe();
    try { managed.session.dispose(); } catch { /* ignore */ }
    this.agents.delete(agentId);

    this.emit({ type: "agent:destroyed", agentId });
    this.emitAgentList();
  }

  /** Get agent info */
  getAgentInfo(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId)?.info;
  }

  /** List all agents */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(a => ({ ...a.info }));
  }

  /** Get agent messages */
  getMessages(agentId: string): AgentMessage[] {
    return this.agents.get(agentId)?.messages ?? [];
  }

  // ============================================================
  // Messaging
  // ============================================================

  async sendMessage(agentId: string, text: string, fromAgentId?: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) {
      this.emit({ type: "error", agentId, message: `Agent ${agentId} not found` });
      return;
    }

    this.updateStatus(agentId, "thinking");

    const msgId = uuidv4();
    const userMsg: AgentMessage = {
      id: msgId,
      agentId,
      role: "user",
      content: fromAgentId ? `[@${fromAgentId}] ${text}` : text,
      timestamp: Date.now(),
    };
    this.addMessage(agentId, userMsg);

    try {
      await managed.session.prompt(text);

      // Layer 2 — pi agent error state check (after prompt completes)
      const errorMsg = managed.session.agent?.state?.errorMessage;
      if (errorMsg) {
        this.emit({ type: "error", agentId, message: `Agent error: ${errorMsg}` });
        this.updateStatus(agentId, "error");
      }
    } catch (err: any) {
      // Layer 2 — prompt-level failure (network, auth, rate limit)
      const agentError = managed.session.agent?.state?.errorMessage;
      const detail = agentError ? ` (agent: ${agentError})` : "";
      this.emit({
        type: "error",
        agentId,
        message: `Prompt failed: ${err.message}${detail}`,
      });
      this.updateStatus(agentId, "error");
    }
  }

  async askAgent(agentId: string, question: string, timeoutMs: number): Promise<string> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent ${agentId} not found`);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for agent ${agentId}`));
      }, timeoutMs);

      managed.resolveWait = () => {
        clearTimeout(timer);
        const lastAssistant = [...managed.messages].reverse().find(m => m.role === "assistant");
        resolve(lastAssistant?.content ?? "(no response)");
      };

      this.sendMessage(agentId, question);
    });
  }

  async waitForAgent(agentId: string, timeoutMs: number): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent ${agentId} not found`);
    if (managed.info.status === "idle") return;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for agent ${agentId}`));
      }, timeoutMs);

      managed.resolveWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // ============================================================
  // Thinking Level
  // ============================================================

  /** Update thinking level for an agent */
  setThinkingLevel(agentId: string, level: ThinkingLevel): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.session.setThinkingLevel(level);
    managed.info.thinkingLevel = level;
    this.emit({ type: "agent:updated", agent: { ...managed.info } });
  }

  // ============================================================
  // Session Event Handling
  // ============================================================

  private handleSessionEvent(agentId: string, event: any): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    switch (event.type) {
      case "message_start": {
        if (event.message?.role === "assistant") {
          const msgId = uuidv4();
          this.addMessage(agentId, {
            id: msgId,
            agentId,
            role: "assistant",
            content: "",
            thinking: "",
            timestamp: Date.now(),
            isStreaming: true,
            toolCalls: [],
          });
        }
        break;
      }

      case "message_update": {
        const evt = event.assistantMessageEvent;
        if (!evt) break;

        const streamingMsg = [...managed.messages].reverse().find(m => m.isStreaming);
        if (!streamingMsg) break;

        if (evt.type === "text_delta") {
          streamingMsg.content += evt.delta;
          this.emit({ type: "agent:message-update", agentId, messageId: streamingMsg.id, delta: evt.delta, deltaType: "text" });
        } else if (evt.type === "thinking_delta") {
          streamingMsg.thinking = (streamingMsg.thinking ?? "") + evt.delta;
          this.emit({ type: "agent:message-update", agentId, messageId: streamingMsg.id, delta: evt.delta, deltaType: "thinking" });
        }
        break;
      }

      case "message_end": {
        const msg = event.message;
        const streamingMsg = [...managed.messages].reverse().find(m => m.isStreaming);
        if (streamingMsg) {
          streamingMsg.isStreaming = false;
          this.emit({
            type: "agent:message-end",
            agentId,
            messageId: streamingMsg.id,
            content: streamingMsg.content,
            thinking: streamingMsg.thinking ?? "",
          });
        }

        // Track usage if available (pi AssistantMessage.usage)
        if (msg?.role === "assistant" && msg.usage) {
          this.trackUsage(agentId, msg.usage);
        }
        managed.info.messageCount = managed.messages.length;
        break;
      }

      case "tool_execution_start": {
        this.updateStatus(agentId, "working");
        // Find the message to attach tool calls to: prefer streaming, fallback to last assistant
        const targetMsg = [...managed.messages].reverse().find(m => m.isStreaming && m.role === "assistant")
          ?? [...managed.messages].reverse().find(m => m.role === "assistant");

        if (!targetMsg) break; // No assistant message yet — shouldn't happen in normal flow

        const tc: ToolCallRecord = {
          callId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
          status: "running",
        };
        targetMsg.toolCalls = [...(targetMsg.toolCalls ?? []), tc];

        // Permission check
        const perm = checkPermission(event.toolName, event.args ?? {}, managed.info.role);
        if (perm.action === "deny") {
          tc.status = "error";
          tc.result = `BLOCKED: ${perm.reason}`;
          tc.isError = true;
          this.emit({
            type: "agent:tool-end", agentId, messageId: targetMsg.id,
            callId: event.toolCallId, result: tc.result, isError: true,
          });
          break;
        }

        if (perm.action === "ask") {
          this.emit({
            type: "permission:request",
            requestId: event.toolCallId, agentId,
            toolName: event.toolName, args: event.args ?? {}, reason: perm.reason,
          });
        }

        this.emit({
          type: "agent:tool-start", agentId, messageId: targetMsg.id,
          toolCall: { ...tc },
        });
        break;
      }

      case "tool_execution_update": {
        const streamingMsg = [...managed.messages].reverse().find(m => m.isStreaming);
        if (streamingMsg) {
          this.emit({
            type: "agent:tool-update", agentId, messageId: streamingMsg.id,
            callId: event.toolCallId, partial: event.partialResult ?? "",
          });
        }
        break;
      }

      case "tool_execution_end": {
        // Find the message containing this tool call
        const targetMsg = [...managed.messages].reverse().find(m =>
          m.role === "assistant" && m.toolCalls?.some(t => t.callId === event.toolCallId)
        );
        if (targetMsg) {
          const tc = targetMsg.toolCalls?.find(t => t.callId === event.toolCallId);
          if (tc) {
            tc.status = event.isError ? "error" : "success";
            tc.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
            tc.isError = event.isError;
          }
          this.emit({
            type: "agent:tool-end", agentId, messageId: targetMsg.id,
            callId: event.toolCallId, result: tc?.result ?? "", isError: event.isError ?? false,
          });
        }
        break;
      }

      case "agent_end": {
        this.updateStatus(agentId, "idle");
        if (managed.resolveWait) {
          managed.resolveWait();
          managed.resolveWait = undefined;
        }
        break;
      }

      case "agent_start": {
        this.updateStatus(agentId, "thinking");
        break;
      }
    }
  }

  // ============================================================
  // Usage / Cost Tracking
  // ============================================================

  /** Track token usage from an assistant message (pi's Usage format) */
  private trackUsage(agentId: string, usage: any): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const snapshot: UsageSnapshot = {
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

    // Accumulate
    const cumulative = this.agentUsage.get(agentId) ?? { ...EMPTY_USAGE };
    cumulative.inputTokens += snapshot.inputTokens;
    cumulative.outputTokens += snapshot.outputTokens;
    cumulative.cacheReadTokens += snapshot.cacheReadTokens;
    cumulative.cacheWriteTokens += snapshot.cacheWriteTokens;
    cumulative.totalTokens += snapshot.totalTokens;
    cumulative.cost.input += snapshot.cost.input;
    cumulative.cost.output += snapshot.cost.output;
    cumulative.cost.cacheRead += snapshot.cost.cacheRead;
    cumulative.cost.cacheWrite += snapshot.cost.cacheWrite;
    cumulative.cost.total += snapshot.cost.total;

    this.agentUsage.set(agentId, cumulative);
    managed.info.usage = { ...cumulative };

    this.emit({ type: "agent:usage-update", agentId, usage: { ...cumulative } });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private updateStatus(agentId: string, status: AgentStatus): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.info.status = status;
    this.emit({ type: "agent:status", agentId, status });
  }

  private addMessage(agentId: string, msg: AgentMessage): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.messages.push(msg);
    managed.info.messageCount = managed.messages.length;
    this.emit({ type: "agent:message", message: msg });
  }

  private emitAgentList(): void {
    this.emit({ type: "agent:list", agents: this.listAgents() });
  }

  /** Subscribe to all events */
  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter(cb => cb !== callback);
    };
  }

  private emit(event: MainToRendererEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  /** Build custom tools for an agent */
  private buildCustomTools(toolNames: string[], agentId: string): any[] {
    const tools: any[] = [];

    const orchTools = ["spawn_agent", "send_to_agent", "ask_agent", "wait_for_agent", "list_agents"];
    if (toolNames.some(t => orchTools.includes(t))) {
      tools.push(...createOrchestrationTools(this, agentId));
    }

    return tools;
  }
}
