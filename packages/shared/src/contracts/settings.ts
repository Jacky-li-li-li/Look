import type { PermissionMode } from "./permission.js";

export type UILanguage = "en" | "zh" | "ja";
export type LookTone = "light" | "dark";

/**
 * Desktop notification delivery mode.
 * - "off": never show OS notifications
 * - "needs-action": only notify when the agent is blocked waiting for user input
 *   (permission / plan question / plan approval / OAuth login)
 * - "all": notify for needs-action, task completion and errors (default)
 */
export type DesktopNotificationMode = "off" | "needs-action" | "all";

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
	/** OS desktop notification mode. UI preference, persisted in ui-settings.json. */
	desktopNotifications: DesktopNotificationMode;
}
