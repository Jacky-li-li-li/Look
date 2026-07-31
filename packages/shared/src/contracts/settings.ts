import type { PermissionMode } from "./permission.js";

export type UILanguage = "en" | "zh" | "ja";
export type LookTone = "light" | "dark";

/** Canonical settings contract shared by main, preload IPC, and renderer. */
export interface UserSettings {
	language: UILanguage;
	autoCollapse: boolean;
	compactionEnabled: boolean;
	/** Tokens reserved for the LLM response during compaction. Read-only — owned by the SDK
	 *  SettingsManager (settings.json: compaction.reserveTokens), never written through `update`. */
	compactionReserveTokens: number;
	/** Recent tokens preserved during compaction. Read-only — owned by the SDK
	 *  SettingsManager (settings.json: compaction.keepRecentTokens), never written through `update`. */
	compactionKeepRecentTokens: number;
	permissionMode: PermissionMode;
	preferredModel: string | null;
	/** Model used specifically when entering Plan mode. null = inherit current session model. */
	planModel: string | null;
	lastActiveSessionId: string;
	lastActiveProjectId: string;
	openProjectIds: string[];
	openedSessionIds: string[];
	themeTone: LookTone;
	autoTitleModel: string | null;
	subagentEnabled: boolean;
	enabledAgentDefinitions: string[] | null;
	enabledSkills: string[] | null;
	sidebarCollapsed: boolean;
	rightPanelCollapsed: boolean;
	aiAvatar: string | null;
}
