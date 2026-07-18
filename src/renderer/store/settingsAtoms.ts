import { atom } from "jotai";
import type { CustomProviderInput } from "../components/settings/types";

export interface CustomProviderStats {
	configured: number;
	totalModels: number;
}

interface SettingsProviderInfo {
	id: string;
	name: string;
	hasKey: boolean;
	envVar?: string;
	modelsAvailable: number;
	models?: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
	}>;
	authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	envLabel?: string;
}

export interface ProviderSettingsData {
	providers: SettingsProviderInfo[];
	customProviders: CustomProviderInput[];
	customStats: CustomProviderStats;
}

export const autoCollapseAtom = atom(true);

export const userPreferredModelAtom = atom<string | null>(null);

export const subagentEnabledAtom = atom(true);

export const enabledAgentDefinitionsAtom = atom<string[] | null>(null);

export const enabledSkillsAtom = atom<string[] | null>(null);

export const providerSettingsAtom = atom<ProviderSettingsData>({
	providers: [],
	customProviders: [],
	customStats: { configured: 0, totalModels: 0 },
});

export const mcpStatusVersionAtom = atom(0);

export interface UsageAtomData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, { turns: number; cost: number }>>;
	years: number[];
}

export const usageDataAtom = atom<UsageAtomData | null>(null);

export const usageVersionAtom = atom(0);

export interface UpdateStatus {
	stage: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
	version?: string;
	percent?: number;
	message?: string;
}

export const updateStatusAtom = atom<UpdateStatus | null>(null);

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
