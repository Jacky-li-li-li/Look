// ============================================================
// UserSettingsStore — Persists UI-level user preferences
//
// Field split (intentional, matches the SDK's design boundary):
//
//   SDK fields — owned by `SettingsManager` in `~/.look/settings.json`:
//     - preferredModel        → SDK `setDefaultModelAndProvider`
//     The SDK's settings file only persists fields its schema
//     knows about; any keys we tried to sneak in via
//     `applyOverrides` got silently dropped on flush because
//     only the SDK's own setters mark a field as modified. We
//     keep these on the SDK side so future SDK versions keep
//     the contract.
//
//   UI fields — owned by this class in `~/.look/ui-settings.json`:
//     - language / autoCollapse / compactionEnabled
//     These are Look-app concerns, not pi-agent concerns, so
//     the SDK has no schema entry for them. We persist them
//     in a sibling file under the same `~/.look/` root.
//
// The `getAll` / `update` / `reset` API merges both halves so
// callers see a single `UserSettings` object.
// ============================================================

import type { DesktopNotificationMode, LookTone, PermissionMode, UILanguage, UserSettings } from "@look/shared/types";
import fs from "fs";
import { writeJsonFile } from "../utils/atomic-writer.js";

export type { LookTone, UILanguage, UserSettings } from "@look/shared/types";

const DEFAULTS: UserSettings = {
	language: "en",
	autoCollapse: true,
	compactionEnabled: true,
	compactionReserveTokens: 16384,
	compactionKeepRecentTokens: 20000,
	permissionMode: "ask",
	preferredModel: null,
	planModel: null,
	lastActiveSessionId: "",
	lastActiveProjectId: "",
	openProjectIds: [],
	openedSessionIds: [],
	themeTone: "dark",
	autoTitleModel: null,
	subagentEnabled: true,
	enabledAgentDefinitions: null,
	enabledSkills: null,
	sidebarCollapsed: false,
	rightPanelCollapsed: false,
	aiAvatar: null,
	desktopNotifications: "all",
};

/** Subset of UserSettings owned by the SDK's SettingsManager. */
interface SdkSettings {
	preferredModel: string | null;
}

/** Subset of UserSettings owned by this class (ui-settings.json). */
interface UiSettings {
	language: UILanguage;
	autoCollapse: boolean;
	compactionEnabled: boolean;
	/** Permission mode for tool call authorization. */
	permissionMode: PermissionMode;
	/** Last active pi session ID to restore on restart. */
	lastActiveSessionId: string;
	/** Last active project ID to restore on restart. */
	lastActiveProjectId: string;
	openProjectIds: string[];
	/** Session IDs opened as sheets in the top bar. */
	openedSessionIds: string[];
	/** Active tone variant (light / dark). */
	themeTone: LookTone;
	/** Model used to auto-generate the first session title. See UserSettings.autoTitleModel. */
	autoTitleModel: string | null;
	/** Model used specifically when entering Plan mode. See UserSettings.planModel. */
	planModel: string | null;
	/** SubAgent 功能总开关。 */
	subagentEnabled: boolean;
	/** 已启用的 SubAgent 定义名称列表。null=全部启用（向后兼容） */
	enabledAgentDefinitions: string[] | null;
	/** 已启用的 Skill 名称列表。null=全部启用（向后兼容） */
	enabledSkills: string[] | null;
	/** 侧边栏是否折叠 */
	sidebarCollapsed: boolean;
	/** 右侧面板是否折叠 */
	rightPanelCollapsed: boolean;
	/** AI 消息头像 ID（avatar-01…avatar-24）。null=使用默认像素头像。 */
	aiAvatar: string | null;
	/** OS 桌面通知模式（off / needs-action / all）。 */
	desktopNotifications: DesktopNotificationMode;
}

const UI_DEFAULTS: UiSettings = {
	language: DEFAULTS.language,
	autoCollapse: DEFAULTS.autoCollapse,
	compactionEnabled: DEFAULTS.compactionEnabled,
	permissionMode: "ask",
	lastActiveSessionId: "",
	lastActiveProjectId: "",
	openProjectIds: [],
	openedSessionIds: [],
	themeTone: "dark",
	autoTitleModel: null,
	planModel: null,
	subagentEnabled: true,
	enabledAgentDefinitions: null,
	enabledSkills: null,
	sidebarCollapsed: false,
	rightPanelCollapsed: false,
	aiAvatar: null,
	desktopNotifications: "all",
};

/** Synchronously read the persisted tone from disk without instantiating the
 *  full store. Used at window-creation time before the runtime manager exists. */
export function readThemeToneSync(uiSettingsPath: string): LookTone {
	try {
		if (fs.existsSync(uiSettingsPath)) {
			const parsed = JSON.parse(fs.readFileSync(uiSettingsPath, "utf-8")) as Record<string, unknown>;
			if (parsed.themeTone === "light" || parsed.themeTone === "dark") return parsed.themeTone;
		}
	} catch {
		/* fall through to default */
	}
	return UI_DEFAULTS.themeTone;
}

/** Minimal surface we need from `SettingsManager` — the SDK
 *  fields' getters + setters that mark themselves as modified
 *  on set, plus `flush()` for the durability boundary. */
type SettingsManagerLike = {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
	setDefaultProvider(provider: string): void;
	setDefaultModel(modelId: string): void;
	getCompactionEnabled(): boolean;
	setCompactionEnabled(enabled: boolean): void;
	getCompactionReserveTokens(): number;
	getCompactionKeepRecentTokens(): number;
	flush(): Promise<void>;
};

export class UserSettingsStore {
	private ui: UiSettings;
	private readonly settingsManager: SettingsManagerLike;
	private readonly uiSettingsPath: string;

	constructor(settingsManager: SettingsManagerLike, uiSettingsPath: string) {
		this.settingsManager = settingsManager;
		this.uiSettingsPath = uiSettingsPath;
		const { settings, migrated } = this.readUi();
		this.ui = settings;
		if (migrated) this.writeUi();
	}

	// ----- read -----

	/** Read merged settings: SDK fields + Look UI fields, falling
	 *  back to defaults for anything missing. */
	getAll(): UserSettings {
		const sdk = this.readSdk();
		return {
			...DEFAULTS,
			...this.ui,
			preferredModel: sdk.preferredModel ?? DEFAULTS.preferredModel,
			compactionEnabled: this.settingsManager.getCompactionEnabled() ?? DEFAULTS.compactionEnabled,
			// Read-only SDK fields: always the SDK's live value, never persisted by us.
			compactionReserveTokens: this.settingsManager.getCompactionReserveTokens(),
			compactionKeepRecentTokens: this.settingsManager.getCompactionKeepRecentTokens(),
		};
	}

	private readSdk(): SdkSettings {
		return {
			preferredModel: this.composePreferredModel(),
		};
	}

	private composePreferredModel(): string | null {
		const provider = this.settingsManager.getDefaultProvider();
		const modelId = this.settingsManager.getDefaultModel();
		if (!provider || !modelId) return null;
		return `${provider}/${modelId}`;
	}

	private readUi(): { settings: UiSettings; migrated: boolean } {
		try {
			if (fs.existsSync(this.uiSettingsPath)) {
				const raw = fs.readFileSync(this.uiSettingsPath, "utf-8");
				const parsed = JSON.parse(raw);
				let migrated = false;
				if (!parsed.lastActiveSessionId && parsed.lastActiveAgentId) {
					parsed.lastActiveSessionId = parsed.lastActiveAgentId;
				}
				if (!Array.isArray(parsed.openProjectIds)) parsed.openProjectIds = [];
				if (!Array.isArray(parsed.openedSessionIds)) parsed.openedSessionIds = [];
				if ("themeStyle" in parsed) {
					delete parsed.themeStyle;
					migrated = true;
				}
				if (parsed.themeTone !== "light" && parsed.themeTone !== "dark") {
					parsed.themeTone = UI_DEFAULTS.themeTone;
					migrated = true;
				}
				// Merge with defaults so newly-added fields get sane values
				// when loading an older file.
				return { settings: { ...UI_DEFAULTS, ...parsed }, migrated };
			}
		} catch (err) {
			console.warn("[Look] Failed to load ui-settings.json, using defaults:", err);
		}
		return { settings: { ...UI_DEFAULTS }, migrated: false };
	}

	// ----- write -----

	/** Update + persist. Awaits `flush()` on both backends so the
	 *  returned snapshot is guaranteed to be on disk by the time
	 *  the caller gets it. */
	async update(partial: Partial<UserSettings>): Promise<UserSettings> {
		// SDK fields: dispatch through the SDK's own setters so they
		// are marked as modified and `flush()` writes them.
		if (partial.preferredModel !== undefined) {
			if (partial.preferredModel) {
				const [provider, ...parts] = partial.preferredModel.split("/");
				this.settingsManager.setDefaultModelAndProvider(provider, parts.join("/"));
			} else {
				// Clearing the preferred model: clear both halves so we
				// don't leave a stale provider/model behind.
				this.settingsManager.setDefaultProvider("");
				this.settingsManager.setDefaultModel("");
			}
		}
		if (partial.compactionEnabled !== undefined) {
			this.settingsManager.setCompactionEnabled(partial.compactionEnabled);
		}
		// UI fields: persist into our sibling file.
		const uiPartial: Partial<UiSettings> = {};
		if (partial.language !== undefined) uiPartial.language = partial.language;
		if (partial.autoCollapse !== undefined) uiPartial.autoCollapse = partial.autoCollapse;
		if (partial.compactionEnabled !== undefined) uiPartial.compactionEnabled = partial.compactionEnabled;
		if (partial.permissionMode !== undefined) uiPartial.permissionMode = partial.permissionMode;
		if (partial.lastActiveSessionId !== undefined) uiPartial.lastActiveSessionId = partial.lastActiveSessionId;
		if (partial.lastActiveProjectId !== undefined) uiPartial.lastActiveProjectId = partial.lastActiveProjectId;
		if (partial.openProjectIds !== undefined) uiPartial.openProjectIds = [...partial.openProjectIds];
		if (partial.openedSessionIds !== undefined) uiPartial.openedSessionIds = [...partial.openedSessionIds];
		if (partial.themeTone !== undefined) uiPartial.themeTone = partial.themeTone;
		if (partial.autoTitleModel !== undefined) uiPartial.autoTitleModel = partial.autoTitleModel;
		if (partial.planModel !== undefined) uiPartial.planModel = partial.planModel;
		if (partial.subagentEnabled !== undefined) uiPartial.subagentEnabled = partial.subagentEnabled;
		if (partial.enabledAgentDefinitions !== undefined)
			uiPartial.enabledAgentDefinitions =
				partial.enabledAgentDefinitions === null ? null : [...partial.enabledAgentDefinitions];
		if (partial.enabledSkills !== undefined)
			uiPartial.enabledSkills = partial.enabledSkills === null ? null : [...partial.enabledSkills];
		if (partial.sidebarCollapsed !== undefined) uiPartial.sidebarCollapsed = partial.sidebarCollapsed;
		if (partial.rightPanelCollapsed !== undefined) uiPartial.rightPanelCollapsed = partial.rightPanelCollapsed;
		if (partial.aiAvatar !== undefined) uiPartial.aiAvatar = partial.aiAvatar;
		if (partial.desktopNotifications !== undefined) uiPartial.desktopNotifications = partial.desktopNotifications;
		if (Object.keys(uiPartial).length > 0) {
			this.ui = { ...this.ui, ...uiPartial };
			this.writeUi();
		}
		try {
			await this.settingsManager.flush();
		} catch (err) {
			console.error("[Look] Failed to flush settings.json:", err);
		}
		return this.getAll();
	}

	async reset(): Promise<UserSettings> {
		// SDK fields: clear both halves of the provider/model pair.
		this.settingsManager.setDefaultProvider("");
		this.settingsManager.setDefaultModel("");
		// UI fields: rewrite to defaults on disk.
		this.ui = { ...UI_DEFAULTS };
		this.writeUi();
		try {
			await this.settingsManager.flush();
		} catch (err) {
			console.error("[Look] Failed to flush settings.json:", err);
		}
		return this.getAll();
	}

	private writeUi(): void {
		try {
			writeJsonFile(this.uiSettingsPath, this.ui, false);
		} catch (err) {
			console.error("[Look] Failed to write ui-settings.json:", err);
		}
	}
}
