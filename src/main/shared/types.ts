// ============================================================
// Shared types for Look
// Used by both main process and renderer
// ============================================================

/** Agent role template */
export type AgentRole =
  | "chat"        // 通用聊天 agent
  | "orchestrator"
  | "coder"
  | "reviewer"
  | "crawler"
  | "cleaner"
  | "analyst"
  | "reporter"
  | "custom";

/** Agent status */
export type AgentStatus = "idle" | "thinking" | "working" | "error" | "destroyed";

/** Pi thinking level — matches pi's built-in levels */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Token usage and cost snapshot */
export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Agent definition (config, not runtime) */
export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  tools: string[];
  isDefault: boolean;
}

/** Runtime agent info sent to renderer */
export interface AgentInfo {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  thinkingLevel: ThinkingLevel;
  status: AgentStatus;
  messageCount: number;
  createdAt: number;
  /** Cumulative token usage */
  usage: UsageSnapshot;
  /** Fallback model chain (provider/model-id) */
  fallbackModels: string[];
}

/** A single message in an agent's conversation */
export interface AgentMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  timestamp: number;
  isStreaming?: boolean;
  /** Token usage for this message (assistant messages only) */
  usage?: UsageSnapshot;
}

/** Record of a tool call */
export interface ToolCallRecord {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  status: "pending" | "running" | "success" | "error";
}

// ============================================================
// Events (Main ↔ Renderer)
// ============================================================

/** Events sent from main process to renderer */
export type MainToRendererEvent =
  | { type: "agent:list"; agents: AgentInfo[] }
  | { type: "agent:created"; agent: AgentInfo }
  | { type: "agent:destroyed"; agentId: string }
  | { type: "agent:updated"; agent: AgentInfo }
  | { type: "agent:status"; agentId: string; status: AgentStatus }
  | { type: "agent:message"; message: AgentMessage }
  | { type: "agent:message-update"; agentId: string; messageId: string; delta: string; deltaType: "text" | "thinking" }
  | { type: "agent:message-end"; agentId: string; messageId: string; content: string; thinking: string }
  | { type: "agent:tool-start"; agentId: string; messageId: string; toolCall: ToolCallRecord }
  | { type: "agent:tool-update"; agentId: string; messageId: string; callId: string; partial: string }
  | { type: "agent:tool-end"; agentId: string; messageId: string; callId: string; result: string; isError: boolean }
  | { type: "agent:history"; agentId: string; messages: AgentMessage[] }
  | { type: "agent:usage-update"; agentId: string; usage: UsageSnapshot }
  | { type: "permission:request"; requestId: string; agentId: string; toolName: string; args: Record<string, unknown>; reason: string }
  | { type: "error"; agentId?: string; message: string };

/** Events sent from renderer to main process */
export type RendererToMainEvent =
  | { type: "agent:send-message"; agentId: string; message: string; targetAgentId?: string }
  | { type: "agent:create"; name: string; role: AgentRole; thinkingLevel?: ThinkingLevel; model?: string; parentAgentId?: string }
  | { type: "agent:destroy"; agentId: string }
  | { type: "agent:switch-model"; agentId: string; model: string }
  | { type: "agent:update-thinking"; agentId: string; level: ThinkingLevel }
  | { type: "agent:get-history"; agentId: string }
  | { type: "permission:response"; requestId: string; allowed: boolean }
  | { type: "model:list" }
  | { type: "model:providers" }
  | { type: "settings:get" }
  | { type: "settings:set-api-key"; provider: string; key: string }
  | { type: "app:ready" };

// ============================================================
// Tool & Pipeline types
// ============================================================

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  roles: AgentRole[];
}

/** Available model info (returned from ModelRegistry) */
export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}

/** Provider info */
export interface ProviderInfo {
  id: string;
  name: string;
  hasCredentials: boolean;
  models: string[];
}
