import type { PermissionMode } from "./permission.js";

export type UILanguage = "en" | "zh" | "ja";
export type LookTone = "light" | "dark";

/** Canonical settings contract shared by main, preload IPC, and renderer. */
export interface UserSettings {
	language: UILanguage;
	autoCollapse: boolean;
	compactionEnabled: boolean;
	permissionMode: PermissionMode;
	preferredModel: string | null;
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
