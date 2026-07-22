import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { UserSettingsStore } from "../settings/store.js";
import {
	detectCommonSkillPaths,
	discoverSkillsFromPaths,
	isBuiltinSkillPath,
} from "../skills/skill-discovery-service.js";
import type { ActiveSessionSelection } from "./active-session-selection.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

export interface SkillManagementServiceOptions {
	runtimeRegistry: Pick<RuntimeRegistry, "get" | "values">;
	selection: ActiveSessionSelection;
	globalSettingsManager: Pick<SettingsManager, "getSkillPaths" | "setSkillPaths" | "flush">;
	userSettings: Pick<UserSettingsStore, "getAll" | "update">;
}

/** Owns skill discovery, import paths, toggles, and cross-runtime reloads. */
export class SkillManagementService {
	constructor(private readonly options: SkillManagementServiceOptions) {}

	listForUI() {
		const activeRuntime = this.options.selection.currentId
			? this.options.runtimeRegistry.get(this.options.selection.currentId)?.runtime
			: undefined;
		const skillPaths =
			activeRuntime?.services.settingsManager.getSkillPaths() ?? this.options.globalSettingsManager.getSkillPaths();
		const loaded = activeRuntime?.services.resourceLoader.getSkills() ?? { skills: [], diagnostics: [] };
		const rawSkills = loaded.skills.length > 0 ? loaded.skills : discoverSkillsFromPaths(skillPaths);
		return {
			skills: rawSkills.map((skill) => ({
				...skill,
				category: isBuiltinSkillPath(skill) ? ("builtin" as const) : ("mine" as const),
			})),
			diagnostics: loaded.diagnostics,
			importedPaths: skillPaths,
		};
	}

	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const settings = this.options.userSettings.getAll();
		let enabledSkills = settings.enabledSkills;
		if (enabledSkills === null) {
			const allSkills = this.listForUI().skills.map((skill) => skill.name);
			if (allSkills.length === 0) return;
			enabledSkills = enabled ? allSkills : allSkills.filter((skillName) => skillName !== name);
		} else {
			enabledSkills = enabled
				? [...new Set([...enabledSkills, name])]
				: enabledSkills.filter((skillName) => skillName !== name);
		}
		await this.options.userSettings.update({ enabledSkills });
	}

	async importPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const activeRuntime = this.options.selection.currentId
				? this.options.runtimeRegistry.get(this.options.selection.currentId)?.runtime
				: undefined;
			const settingsManager = activeRuntime?.services.settingsManager ?? this.options.globalSettingsManager;
			const currentPaths = new Set(
				settingsManager.getSkillPaths().flatMap((item) => {
					const resolved = item.startsWith("~") ? join(homedir(), item.slice(1)) : item;
					return existsSync(resolved) ? [resolved] : [];
				}),
			);
			const merged = Array.from(
				new Set(
					[...currentPaths, ...paths].flatMap((item) => {
						const resolved = item.startsWith("~") ? join(homedir(), item.slice(1)) : item;
						return existsSync(resolved) ? [resolved] : [];
					}),
				),
			);
			const importedCount = merged.filter((path) => !currentPaths.has(path)).length;
			if (importedCount === 0) return { success: true, importedCount: 0 };
			settingsManager.setSkillPaths(merged);
			await settingsManager.flush();
			await Promise.all(
				Array.from(this.options.runtimeRegistry.values()).map((managed) => managed.runtime.session.reload()),
			);
			return { success: true, importedCount };
		} catch (error) {
			return {
				success: false,
				importedCount: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	detectCommonPaths() {
		return detectCommonSkillPaths();
	}
}
