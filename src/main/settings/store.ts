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

import fs from "fs";
import path from "path";
import type { PermissionMode } from "../shared/types.js";

export type UILanguage = "en" | "zh" | "ja";
export type LookStyle = "ink-wash" | "swiss" | "bauhaus";
export type LookTone = "light" | "dark";

export interface UserSettings {
	language: UILanguage;
	autoCollapse: boolean;
	compactionEnabled: boolean;
	/** Permission mode for tool call authorization. */
	permissionMode: PermissionMode;
	/** The global pi default model. */
	preferredModel: string | null;
	/** Last active pi session ID to restore on restart. */
	lastActiveSessionId: string;
	/** Last active project ID to restore on restart. */
	lastActiveProjectId: string;
	/** Expanded workspace groups in the renderer sidebar. */
	openProjectIds: string[];
	/** Session IDs opened as sheets in the top bar. */
	openedSessionIds: string[];
	/** Active visual style (ink-wash / swiss / bauhaus). */
	themeStyle: LookStyle;
	/** Active tone variant (light / dark). */
	themeTone: LookTone;
	/**
	 * Model used to auto-generate the first session title.
	 * Format: "provider/model-id". `null` means "inherit the session's
	 * current model at generation time". UI surface is the Behavior
	 * tab's "Title generation model" Select.
	 */
	autoTitleModel: string | null;
	/** SubAgent 功能总开关。关闭后所有会话的 subagent 工具对 LLM 不可见。 */
	subagentEnabled: boolean;
	/** 已启用的 SubAgent 定义名称列表。null=全部启用（向后兼容） */
	enabledAgentDefinitions: string[] | null;
	/** 已启用的 Skill 名称列表。null=全部启用（向后兼容） */
	enabledSkills: string[] | null;
}

const DEFAULTS: UserSettings = {
	language: "en",
	autoCollapse: true,
	compactionEnabled: true,
	permissionMode: "ask",
	preferredModel: null,
	lastActiveSessionId: "",
	lastActiveProjectId: "",
	openProjectIds: [],
	openedSessionIds: [],
	themeStyle: "ink-wash",
	themeTone: "dark",
	autoTitleModel: null,
	subagentEnabled: true,
	enabledAgentDefinitions: null,
	enabledSkills: null,
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
	/** Active visual style (ink-wash / swiss / bauhaus). */
	themeStyle: LookStyle;
	/** Active tone variant (light / dark). */
	themeTone: LookTone;
	/** Model used to auto-generate the first session title. See UserSettings.autoTitleModel. */
	autoTitleModel: string | null;
	/** SubAgent 功能总开关。 */
	subagentEnabled: boolean;
	/** 已启用的 SubAgent 定义名称列表。null=全部启用（向后兼容） */
	enabledAgentDefinitions: string[] | null;
	/** 已启用的 Skill 名称列表。null=全部启用（向后兼容） */
	enabledSkills: string[] | null;
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
	themeStyle: "ink-wash",
	themeTone: "dark",
	autoTitleModel: null,
	subagentEnabled: true,
	enabledAgentDefinitions: null,
	enabledSkills: null,
};

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
	flush(): Promise<void>;
};

export class UserSettingsStore {
	private ui: UiSettings;
	private readonly settingsManager: SettingsManagerLike;
	private readonly uiSettingsPath: string;

	constructor(settingsManager: SettingsManagerLike, uiSettingsPath: string) {
		this.settingsManager = settingsManager;
		this.uiSettingsPath = uiSettingsPath;
		this.ui = this.readUi();
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

	private readUi(): UiSettings {
		try {
			if (fs.existsSync(this.uiSettingsPath)) {
				const raw = fs.readFileSync(this.uiSettingsPath, "utf-8");
				const parsed = JSON.parse(raw);
				if (!parsed.lastActiveSessionId && parsed.lastActiveAgentId) {
					parsed.lastActiveSessionId = parsed.lastActiveAgentId;
				}
				if (!Array.isArray(parsed.openProjectIds)) parsed.openProjectIds = [];
				if (!Array.isArray(parsed.openedSessionIds)) parsed.openedSessionIds = [];
				// Merge with defaults so newly-added fields get sane values
				// when loading an older file.
				return { ...UI_DEFAULTS, ...parsed };
			}
		} catch (err) {
			console.warn("[Look] Failed to load ui-settings.json, using defaults:", err);
		}
		return { ...UI_DEFAULTS };
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
		if (partial.themeStyle !== undefined) uiPartial.themeStyle = partial.themeStyle;
		if (partial.themeTone !== undefined) uiPartial.themeTone = partial.themeTone;
		if (partial.autoTitleModel !== undefined) uiPartial.autoTitleModel = partial.autoTitleModel;
		if (partial.subagentEnabled !== undefined) uiPartial.subagentEnabled = partial.subagentEnabled;
		if (partial.enabledAgentDefinitions !== undefined)
			uiPartial.enabledAgentDefinitions =
				partial.enabledAgentDefinitions === null ? null : [...partial.enabledAgentDefinitions];
		if (partial.enabledSkills !== undefined)
			uiPartial.enabledSkills = partial.enabledSkills === null ? null : [...partial.enabledSkills];
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
			fs.mkdirSync(path.dirname(this.uiSettingsPath), { recursive: true });
			fs.writeFileSync(this.uiSettingsPath, JSON.stringify(this.ui, null, 2));
		} catch (err) {
			console.error("[Look] Failed to write ui-settings.json:", err);
		}
	}
}
