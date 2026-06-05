// ============================================================
// UserSettingsStore — Persists UI-level user preferences
//
// Stored in ~/.pi/agent/ui-settings.json alongside auth.json. This
// holds *user preferences* (not credentials, not the SDK's model
// settings) — language, default thinking level, auto-collapse, etc.
// All setters auto-persist; load happens once in the constructor.
// ============================================================

import fs from "fs";
import path from "path";
import type { ThinkingLevel } from "./shared/types.js";
import { getSettingsPath } from "./shared/look-storage.js";

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
}

const DEFAULTS: UserSettings = {
  language: "en",
  defaultThinkingLevel: "medium",
  autoCollapse: true,
  autoCompress: false,
  compressThreshold: 60,
  preferredModel: null,
};

const SETTINGS_PATH = getSettingsPath();

export class UserSettingsStore {
  private data: UserSettings;

  constructor() {
    this.data = this.load();
  }

  private load(): UserSettings {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        // Merge with defaults so newly-added fields get sane values when
        // loading an older file.
        return { ...DEFAULTS, ...parsed };
      }
    } catch (err) {
      // Bad JSON or permission error — fall through to defaults.
      console.warn("[Look] Failed to load ui-settings.json, using defaults:", err);
    }
    return { ...DEFAULTS };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error("[Look] Failed to write ui-settings.json:", err);
    }
  }

  getAll(): UserSettings {
    return { ...this.data };
  }

  update(partial: Partial<UserSettings>): UserSettings {
    this.data = { ...this.data, ...partial };
    this.save();
    return this.getAll();
  }

  reset(): UserSettings {
    this.data = { ...DEFAULTS };
    this.save();
    return this.getAll();
  }
}
