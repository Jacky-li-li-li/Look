// ============================================================
// Agent Role Definitions
// Defines default tools, system prompts, model, thinking, fallbacks per role
// ============================================================

import type { AgentRole, ThinkingLevel } from "../shared/types.js";

export interface RoleConfig {
  role: AgentRole;
  label: string;
  emoji: string;
  description: string;
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  /** Fallback models in priority order — tried if primary model fails */
  fallbackModels: string[];
  tools: string[];
  systemPrompt: string;
}

/**
 * Role configurations.
 * defaultModel format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-20250514")
 * fallbackModels: tried in order when primary fails (rate limit, context overflow, etc.)
 */
export const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = {
  chat: {
    role: "chat",
    label: "通用助手",
    emoji: "💬",
    description: "通用聊天 agent，支持读文件、运行命令、写代码等基础工具。",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "medium",
    fallbackModels: [
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    systemPrompt: `You are a helpful AI assistant. You have access to filesystem tools (read, write, edit, bash) to help with tasks. Be concise and effective.`,
  },

  orchestrator: {
    role: "orchestrator",
    label: "Orchestrator",
    emoji: "🎯",
    description: "Coordinates tasks across agents. Receives user requests and delegates to specialized agents.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "medium",
    fallbackModels: [
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ],
    tools: [
      "read", "bash", "write", "edit",
      "spawn_agent", "send_to_agent", "ask_agent", "wait_for_agent", "list_agents",
    ],
    systemPrompt: `You are the Orchestrator agent in a multi-agent system. Your role is to:
1. Understand user requests and break them down into tasks
2. Delegate tasks to specialized agents using spawn_agent, send_to_agent, or ask_agent
3. Coordinate the workflow and track progress using list_agents and wait_for_agent
4. Synthesize results from sub-agents into coherent responses for the user

Available agents and their roles:
- crawler: Searches and fetches data from the web
- cleaner: Cleans, normalizes, and preprocesses data
- analyst: Analyzes data, detects trends, extracts insights
- reporter: Generates structured reports and charts
- coder: Writes and modifies code
- reviewer: Reviews code for quality and issues

When the user gives a complex task:
1. Use list_agents to see what agents are available
2. spawn_agent to create any needed agents
3. send_to_agent to assign tasks
4. wait_for_agent to wait for completion
5. ask_agent if you need a specific answer from an agent
6. Synthesize and present results clearly

Be concise but thorough. Show the user what's happening at each step.`,
  },

  crawler: {
    role: "crawler",
    label: "Crawler",
    emoji: "🕷️",
    description: "Searches and fetches data from social media, web pages, and other sources.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "low",
    fallbackModels: [
      "anthropic/claude-haiku-4-5-20251001",
      "openai/gpt-4o-mini",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find"],
    systemPrompt: `You are a Data Crawler agent. Your job is to search and fetch data from the web, process URLs, and collect information.`,
  },

  cleaner: {
    role: "cleaner",
    label: "Cleaner",
    emoji: "🧹",
    description: "Cleans, normalizes, deduplicates, and preprocesses raw data.",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    defaultThinkingLevel: "off",
    fallbackModels: [
      "anthropic/claude-sonnet-4-20250514",
      "openai/gpt-4o-mini",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find"],
    systemPrompt: `You are a Data Cleaner agent. Your job is to clean, normalize, and preprocess data.`,
  },

  analyst: {
    role: "analyst",
    label: "Analyst",
    emoji: "📊",
    description: "Analyzes data: sentiment, trends, topics, insights extraction.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "high",
    fallbackModels: [
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find"],
    systemPrompt: `You are a Data Analyst agent. Analyze data thoroughly and extract actionable insights.`,
  },

  reporter: {
    role: "reporter",
    label: "Reporter",
    emoji: "📝",
    description: "Generates structured reports, charts, and presentations from analysis results.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "medium",
    fallbackModels: [
      "anthropic/claude-haiku-4-5-20251001",
      "openai/gpt-4o",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find"],
    systemPrompt: `You are a Report Generator agent. Generate structured reports from analysis results.`,
  },

  coder: {
    role: "coder",
    label: "Coder",
    emoji: "💻",
    description: "Writes, edits, and debugs code.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "medium",
    fallbackModels: [
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ],
    tools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    systemPrompt: `You are a Coding agent. Write clean, well-documented code. Follow best practices and the project's conventions.`,
  },

  reviewer: {
    role: "reviewer",
    label: "Reviewer",
    emoji: "🔍",
    description: "Reviews code for quality, security, and best practices.",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    defaultThinkingLevel: "off",
    fallbackModels: [
      "anthropic/claude-sonnet-4-20250514",
    ],
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: `You are a Code Reviewer agent. Review code for bugs, security issues, performance problems, and adherence to best practices. Be constructive and specific.`,
  },

  custom: {
    role: "custom",
    label: "Custom",
    emoji: "🤖",
    description: "A custom-configured agent.",
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    defaultThinkingLevel: "medium",
    fallbackModels: [],
    tools: ["read", "bash", "write", "edit"],
    systemPrompt: `You are a versatile AI agent. Help the user with their tasks efficiently.`,
  },
};

/** Get the tool list for a given role */
export function getRoleTools(role: AgentRole): string[] {
  return ROLE_CONFIGS[role]?.tools ?? ROLE_CONFIGS.custom.tools;
}

/** Get system prompt for a given role */
export function getRoleSystemPrompt(role: AgentRole): string {
  return ROLE_CONFIGS[role]?.systemPrompt ?? ROLE_CONFIGS.custom.systemPrompt;
}

/** List all available roles (for UI) */
export function listRoles(): { role: AgentRole; label: string; emoji: string; description: string }[] {
  return Object.values(ROLE_CONFIGS).map(r => ({
    role: r.role,
    label: r.label,
    emoji: r.emoji,
    description: r.description,
  }));
}

/** Get default config for a role (model, thinking, fallbacks) */
export function getRoleDefaults(role: AgentRole): {
  model: string;
  thinkingLevel: ThinkingLevel;
  fallbackModels: string[];
} {
  const config = ROLE_CONFIGS[role] ?? ROLE_CONFIGS.custom;
  return {
    model: config.defaultModel,
    thinkingLevel: config.defaultThinkingLevel,
    fallbackModels: config.fallbackModels,
  };
}
