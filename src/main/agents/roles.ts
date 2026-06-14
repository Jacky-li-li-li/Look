// ============================================================
// Agent Role Definitions
// Defines default tools, system prompts, model, thinking per role
// ============================================================

import type { AgentRole, ThinkingLevel } from "../shared/types.js";

export interface RoleConfig {
	role: AgentRole;
	label: string;
	emoji: string;
	description: string;
	/** null = "no role-default" — the createAgent flow will pick the
	 *  first user-configured model at runtime. */
	defaultModel: string | null;
	defaultThinkingLevel: ThinkingLevel;
	/** null = "all built-in tools"; array = explicit subset. */
	tools: string[] | null;
	/** Empty string = no role system prompt injected (chat mode). */
	systemPrompt: string;
}

/**
 * Role configurations.
 * defaultModel format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-20250514")
 * Dynamic fallback: `createAgent` builds the fallback chain from all
 * user-configured models via `getAvailableModelsSync()`, so the role
 * config itself no longer carries a static fallback chain.
 */
export const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = {
	chat: {
		role: "chat",
		label: "通用助手",
		emoji: "💬",
		// No role preset — the model is chosen by the user at runtime
		// (see the bottom-of-input ModelSelector). `defaultModel: null`
		// signals "no role-default; pick the first user-configured model"
		// at createAgent time. Tools are likewise "blank workstation" so
		// chat agents behave as a generic workbench.
		//
		// We DO inject a minimal system prompt (overridable by the
		// user's chatSystemPrompt setting in agent-manager.sendMessage
		// path) because without it the LLM defaults to echoing tool
		// results back to the user verbatim — which is wrong for any
		// tool that returns documentation (read a SKILL.md → LLM pastes
		// the whole doc into its reply). The two rules below steer the
		// model toward "consume the result, then answer in your own
		// words".
		description: "通用 agent — 所有内置工具全开，模型由用户在底部选择。",
		defaultModel: null,
		defaultThinkingLevel: "medium",
		tools: null,
		systemPrompt: `You are a helpful assistant with access to tools.

Tool usage:
- Tool results are private to your reasoning. Do NOT echo them
  verbatim to the user — synthesize a concise answer instead.
- Only show tool output directly when the user explicitly asks
  (e.g. "show me the file" or "display the document").

Response style:
- Be concise. Prefer a short answer with a clear next step.`,
	},

	crawler: {
		role: "crawler",
		label: "Crawler",
		emoji: "🕷️",
		description: "Searches and fetches data from social media, web pages, and other sources.",
		defaultModel: "anthropic/claude-sonnet-4-20250514",
		defaultThinkingLevel: "low",
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
		tools: ["read", "bash", "write", "edit"],
		systemPrompt: `You are a versatile AI agent. Help the user with their tasks efficiently.`,
	},
};

export function normalizeAgentRole(role: unknown): AgentRole {
	return typeof role === "string" && role in ROLE_CONFIGS ? (role as AgentRole) : "custom";
}

/** Get the tool list for a given role.
 *
 *  Returns `null` (sentinel for "all built-in tools") if the role
 *  config says so — the caller (AgentManager) interprets null as
 *  "open up the full set of built-ins". */
export function getRoleTools(role: AgentRole): string[] | null {
	return ROLE_CONFIGS[role]?.tools ?? ROLE_CONFIGS.custom.tools;
}

/** Get system prompt for a given role. Empty string = "no role
 *  preset; let the user (or runtime) decide". */
export function getRoleSystemPrompt(role: AgentRole): string {
	return ROLE_CONFIGS[role]?.systemPrompt ?? ROLE_CONFIGS.custom.systemPrompt;
}

/** List all available roles (for UI) */
export function listRoles(): { role: AgentRole; label: string; emoji: string; description: string }[] {
	return Object.values(ROLE_CONFIGS).map((r) => ({
		role: r.role,
		label: r.label,
		emoji: r.emoji,
		description: r.description,
	}));
}

/** Get default config for a role (model, thinking level).
 *  `model` may be null ("no role-default; pick first user-configured").
 *  Dynamic fallback: `createAgent` builds the fallback chain from all
 *  user-configured models via `getAvailableModelsSync()`. */
export function getRoleDefaults(role: AgentRole): {
	model: string | null;
	thinkingLevel: ThinkingLevel;
} {
	const config = ROLE_CONFIGS[role] ?? ROLE_CONFIGS.custom;
	return {
		model: config.defaultModel,
		thinkingLevel: config.defaultThinkingLevel,
	};
}
