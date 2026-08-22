import type { PermissionMode } from "./permission.js";

export type UILanguage = "en" | "zh" | "ja";

/** Display mode is a global setting, independent from the color theme. */
export type LookTone = "light" | "dark";

export const LOOK_TONE_VALUES: readonly LookTone[] = ["light", "dark"] as const;

export function isLookTone(value: unknown): value is LookTone {
	return typeof value === "string" && (LOOK_TONE_VALUES as readonly string[]).includes(value);
}

/** Fixed color-theme families. Their light/dark palettes live in App.css. */
export type LookThemeStyle = "graphite" | "azure" | "dune" | "iris" | "pine";

export const LOOK_THEME_STYLE_VALUES: readonly LookThemeStyle[] = [
	"graphite",
	"azure",
	"dune",
	"iris",
	"pine",
] as const;

export function isLookThemeStyle(value: unknown): value is LookThemeStyle {
	return typeof value === "string" && (LOOK_THEME_STYLE_VALUES as readonly string[]).includes(value);
}

/** The complete visual preference persisted in ui-settings.json. */
export interface LookTheme {
	themeStyle: LookThemeStyle;
	themeTone: LookTone;
}

export const DEFAULT_LOOK_THEME: LookTheme = {
	themeStyle: "graphite",
	themeTone: "dark",
};

/**
 * Values persisted before themes and display mode became independent. The first
 * group is from the immediately preceding theme matrix; the rest are retired
 * designer palettes. Keeping this map lets upgraded installs retain both their
 * palette family and their light/dark preference.
 */
export const LOOK_THEME_LEGACY_MAP: Readonly<Record<string, LookTheme>> = {
	"azure-light": { themeStyle: "azure", themeTone: "light" },
	"azure-dark": { themeStyle: "azure", themeTone: "dark" },
	"dune-light": { themeStyle: "dune", themeTone: "light" },
	"dune-dark": { themeStyle: "dune", themeTone: "dark" },
	"iris-light": { themeStyle: "iris", themeTone: "light" },
	"iris-dark": { themeStyle: "iris", themeTone: "dark" },
	"pine-light": { themeStyle: "pine", themeTone: "light" },
	"pine-dark": { themeStyle: "pine", themeTone: "dark" },
	"catppuccin-mocha": { themeStyle: "iris", themeTone: "dark" },
	"catppuccin-latte": { themeStyle: "iris", themeTone: "light" },
	"tokyo-night": { themeStyle: "azure", themeTone: "dark" },
	"gruvbox-dark": { themeStyle: "dune", themeTone: "dark" },
	"gruvbox-light": { themeStyle: "dune", themeTone: "light" },
	"rose-pine": { themeStyle: "iris", themeTone: "dark" },
	"rose-pine-dawn": { themeStyle: "iris", themeTone: "light" },
};

/**
 * Normalize any persisted settings object to the current independent model.
 * A valid modern field wins over an inferred legacy value, so a manually chosen
 * fixed theme is preserved even if an old composite tone remains on disk.
 */
export function resolveLookTheme(value: unknown): LookTheme {
	const settings = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	const legacyTone = typeof settings?.themeTone === "string" ? LOOK_THEME_LEGACY_MAP[settings.themeTone] : undefined;

	return {
		themeStyle: isLookThemeStyle(settings?.themeStyle)
			? settings.themeStyle
			: (legacyTone?.themeStyle ?? DEFAULT_LOOK_THEME.themeStyle),
		themeTone: isLookTone(settings?.themeTone)
			? settings.themeTone
			: (legacyTone?.themeTone ?? DEFAULT_LOOK_THEME.themeTone),
	};
}

/**
 * BrowserWindow background colors mirror each theme's `--background` token,
 * preventing a flash of the wrong surface during window creation or a switch.
 * Keep in sync with App.css and public/theme-bootstrap.js.
 */
const LOOK_THEME_WINDOW_BACKGROUNDS: Record<LookThemeStyle, Record<LookTone, string>> = {
	graphite: { light: "#fbfbfa", dark: "#030202" },
	azure: { light: "#eff4f8", dark: "#0a0f19" },
	dune: { light: "#f7f3e8", dark: "#1a150f" },
	iris: { light: "#f6f1fa", dark: "#130f1c" },
	pine: { light: "#eff5f0", dark: "#07120d" },
};

export function getLookThemeWindowBackground(themeStyle: LookThemeStyle, themeTone: LookTone): string {
	return LOOK_THEME_WINDOW_BACKGROUNDS[themeStyle][themeTone];
}

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
	/** Fixed color theme, independent from the light/dark display mode. */
	themeStyle: LookThemeStyle;
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
	/** Built-in browser panel master switch; when on, the panel auto-opens while the agent uses browser tools. */
	builtinBrowserEnabled: boolean;
}
