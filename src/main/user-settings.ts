// ============================================================
// UserSettingsStore — Persists UI-level user preferences
//
// Field split (intentional, matches the SDK's design boundary):
//
//   SDK fields — owned by `SettingsManager` in `~/.look/settings.json`:
//     - defaultThinkingLevel  → SDK `setDefaultThinkingLevel`
//     - preferredModel        → SDK `setDefaultModelAndProvider`
//     The SDK's settings file only persists fields its schema
//     knows about; any keys we tried to sneak in via
//     `applyOverrides` got silently dropped on flush because
//     only the SDK's own setters mark a field as modified. We
//     keep these on the SDK side so future SDK versions keep
//     the contract.
//
//   UI fields — owned by this class in `~/.look/ui-settings.json`:
//     - language / autoCollapse / autoCompress / compressThreshold
//     These are Look-app concerns, not pi-agent concerns, so
//     the SDK has no schema entry for them. We persist them
//     in a sibling file under the same `~/.look/` root.
//
// The `getAll` / `update` / `reset` API merges both halves so
// callers see a single `UserSettings` object.
// ============================================================

import fs from "fs";
import path from "path";
import type { ThinkingLevel } from "./shared/types.js";

export type UILanguage = "en" | "zh" | "ja";

export interface UserSettings {
	language: UILanguage;
	defaultThinkingLevel: ThinkingLevel;
	autoCollapse: boolean;
	autoCompress: boolean;
	compressThreshold: number;
	/** The model the user most recently picked in the bottom-bar
	 *  ModelSelector. null = "no preference; pick the first configured".
	 *  Used by App.handleQuickCreateChat to seed new chat agents
	 *  with the user's current pick so they don't snap back to a
	 *  role default. */
	preferredModel: string | null;
	/** Custom system prompt for new chat sessions. Empty string =
	 *  use pi SDK's default coding assistant prompt. */
	chatSystemPrompt: string;
	/** Last active agent ID to restore on restart. */
	lastActiveAgentId: string;
}

const DEFAULTS: UserSettings = {
	language: "en",
	defaultThinkingLevel: "medium",
	autoCollapse: true,
	autoCompress: false,
	compressThreshold: 60,
	preferredModel: null,
	chatSystemPrompt: "",
	lastActiveAgentId: "",
};

/** Subset of UserSettings owned by the SDK's SettingsManager. */
interface SdkSettings {
	defaultThinkingLevel: ThinkingLevel;
	preferredModel: string | null;
}

/** Subset of UserSettings owned by this class (ui-settings.json). */
interface UiSettings {
	language: UILanguage;
	autoCollapse: boolean;
	autoCompress: boolean;
	compressThreshold: number;
	chatSystemPrompt: string;
	/** Last active agent ID to restore on restart. */
	lastActiveAgentId: string;
}

const UI_DEFAULTS: UiSettings = {
	language: DEFAULTS.language,
	autoCollapse: DEFAULTS.autoCollapse,
	autoCompress: DEFAULTS.autoCompress,
	compressThreshold: DEFAULTS.compressThreshold,
	chatSystemPrompt: DEFAULTS.chatSystemPrompt,
	lastActiveAgentId: "",
};

/** Minimal surface we need from `SettingsManager` — the SDK
 *  fields' getters + setters that mark themselves as modified
 *  on set, plus `flush()` for the durability boundary. */
type SettingsManagerLike = {
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	setDefaultThinkingLevel(level: ThinkingLevel): void;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
	setDefaultProvider(provider: string): void;
	setDefaultModel(modelId: string): void;
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
			defaultThinkingLevel: sdk.defaultThinkingLevel ?? DEFAULTS.defaultThinkingLevel,
			preferredModel: sdk.preferredModel ?? DEFAULTS.preferredModel,
		};
	}

	private readSdk(): SdkSettings {
		return {
			defaultThinkingLevel: (this.settingsManager.getDefaultThinkingLevel() ??
				DEFAULTS.defaultThinkingLevel) as ThinkingLevel,
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
		if (partial.defaultThinkingLevel !== undefined) {
			this.settingsManager.setDefaultThinkingLevel(partial.defaultThinkingLevel);
		}
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
		// UI fields: persist into our sibling file.
		const uiPartial: Partial<UiSettings> = {};
		if (partial.language !== undefined) uiPartial.language = partial.language;
		if (partial.autoCollapse !== undefined) uiPartial.autoCollapse = partial.autoCollapse;
		if (partial.autoCompress !== undefined) uiPartial.autoCompress = partial.autoCompress;
		if (partial.compressThreshold !== undefined) uiPartial.compressThreshold = partial.compressThreshold;
		if (partial.chatSystemPrompt !== undefined) uiPartial.chatSystemPrompt = partial.chatSystemPrompt;
		if (partial.lastActiveAgentId !== undefined) uiPartial.lastActiveAgentId = partial.lastActiveAgentId;
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
		// SDK fields: clear both halves of the provider/model pair and
		// reset the thinking level to its default.
		this.settingsManager.setDefaultThinkingLevel(DEFAULTS.defaultThinkingLevel);
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
