import { atom } from "jotai";
import type { CustomProviderInput, ProviderInfo } from "../components/settings/types";

export interface CustomProviderStats {
	configured: number;
	totalModels: number;
}

export interface ProviderSettingsData {
	providers: ProviderInfo[];
	customProviders: CustomProviderInput[];
	customStats: CustomProviderStats;
}

export const autoCollapseAtom = atom(true);

export const userPreferredModelAtom = atom<string | null>(null);

export const subagentEnabledAtom = atom(true);

export const enabledAgentDefinitionsAtom = atom<string[] | null>(null);

export const enabledSkillsAtom = atom<string[] | null>(null);

export const aiAvatarAtom = atom<string | null>(null);

export const providerSettingsAtom = atom<ProviderSettingsData>({
	providers: [],
	customProviders: [],
	customStats: { configured: 0, totalModels: 0 },
});

export const mcpStatusVersionAtom = atom(0);

// ── SDK-aligned usage types ──
// Mirrors pi SDK's Usage type (from session JSONL assistant messages).

export interface SdkUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface SdkUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: SdkUsageCost;
}

/** Aggregated daily usage per model with turn count. */
export interface AggregatedUsage extends SdkUsage {
	turns: number;
}

export interface UsageAtomData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, { turns: number; cost: number }>>;
	modelUsage: Record<string, Record<string, AggregatedUsage>>;
	years: number[];
}

export const usageDataAtom = atom<UsageAtomData | null>(null);

export const usageVersionAtom = atom(0);

export const showSettingsAtom = atom(false);

export type SettingsTab = "general" | "prompt" | "api-keys" | "im-channels" | "about" | "profile" | "mcp";

export const settingsTabAtom = atom<SettingsTab>("general");

export const sidebarCollapsedAtom = atom(false);

export const showAgentSquareAtom = atom(false);

/** Whether the central content area is showing the scheduled-task workspace. */
export const showScheduledTasksAtom = atom(false);

export const activeChatAtBottomAtom = atom(true);

export interface ChatInputInsertRequest {
	id: number;
	agentId: string;
	text: string;
}

export const chatInputInsertRequestAtom = atom<ChatInputInsertRequest | null>(null);

// ── OAuth login prompt ──

export interface LoginPromptState {
	providerId: string;
	promptId: string;
	providerName: string;
	prompt:
		| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> }
		| { type: "manual_code"; message: string; placeholder?: string }
		| { type: "auth_url"; url: string; instructions?: string }
		| { type: "device_code"; userCode: string; verificationUri: string }
		| { type: "info"; message: string }
		| { type: "progress"; message: string };
}

export const loginPromptAtom = atom<LoginPromptState | null>(null);
export const loginCompletedAtom = atom<{ providerId: string; success: boolean; error?: string } | null>(null);
