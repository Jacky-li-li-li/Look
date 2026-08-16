import type { PermissionMode } from "./permission.js";

export type UILanguage = "en" | "zh" | "ja";

/**
 * Look color theme ids. "light" / "dark" are the neutral palette; every other
 * id is a theme-family variant whose palette lives in App.css under
 * `.tone-{scheme}.theme-{id}`.
 */
export type LookTone =
	| "light"
	| "dark"
	| "catppuccin-mocha"
	| "catppuccin-latte"
	| "tokyo-night"
	| "gruvbox-dark"
	| "gruvbox-light"
	| "rose-pine"
	| "rose-pine-dawn";

export const LOOK_TONE_VALUES: readonly LookTone[] = [
	"light",
	"dark",
	"catppuccin-mocha",
	"catppuccin-latte",
	"tokyo-night",
	"gruvbox-dark",
	"gruvbox-light",
	"rose-pine",
	"rose-pine-dawn",
] as const;

export function isLookTone(value: unknown): value is LookTone {
	return typeof value === "string" && (LOOK_TONE_VALUES as readonly string[]).includes(value);
}

/** color-scheme each tone resolves to (drives `tone-light` / `tone-dark` classes). */
export const LOOK_TONE_SCHEME: Record<LookTone, "light" | "dark"> = {
	light: "light",
	dark: "dark",
	"catppuccin-mocha": "dark",
	"catppuccin-latte": "light",
	"tokyo-night": "dark",
	"gruvbox-dark": "dark",
	"gruvbox-light": "light",
	"rose-pine": "dark",
	"rose-pine-dawn": "light",
};

/**
 * BrowserWindow backgroundColor per tone — matches the theme's `--background`
 * so window creation and theme switches never flash the wrong color.
 * Keep in sync with App.css and public/theme-bootstrap.js.
 */
export const LOOK_TONE_WINDOW_BG: Record<LookTone, string> = {
	light: "#fbfbfa",
	dark: "#030202",
	"catppuccin-mocha": "#1e1e2e",
	"catppuccin-latte": "#eff1f5",
	"tokyo-night": "#1a1b26",
	"gruvbox-dark": "#282828",
	"gruvbox-light": "#fbf1c7",
	"rose-pine": "#191724",
	"rose-pine-dawn": "#faf4ed",
};

/**
 * Desktop notification delivery mode.
 * - "off": never show OS notifications
 * - "needs-action": only notify when the agent is blocked waiting for user input
 *   (permission / plan question / plan approval / OAuth login)
 * - "all": notify for needs-action, task completion and errors (default)
 */
export type DesktopNotificationMode = "off" | "needs-action" | "all";

/** Chat bubble alignment mode.
 *  - "left": all bubbles align to the left (compact list style)
 *  - "left-right": user bubbles right, assistant bubbles left (default chat view)
 */
export type MessageAlignment = "left" | "left-right";

/** Whether tool execution details (thinking + tool calls) are shown in the message stream.
 *  - true (default): render thinking panels, tool groups, subagent groups as usual
 *  - false: hide all thinking / tool-call blocks — messages show only text, images, etc.
 */
export type ShowToolExecution = boolean;

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
	/** Right panel width in px, adjustable via drag handle. Default 260. */
	rightPanelWidth: number;
	/** Dock file panel width in px, adjustable via drag handle. Default 420. */
	dockPanelWidth: number;
	aiAvatar: string | null;
	/** OS desktop notification mode. UI preference, persisted in ui-settings.json. */
	desktopNotifications: DesktopNotificationMode;
	/** Chat bubble alignment: "left" (all left) or "left-right" (user right / assistant left). */
	messageAlignment: MessageAlignment;
	/** Show tool execution details (thinking + tool calls) in the message stream. Default true. */
	showToolExecution: ShowToolExecution;
}
