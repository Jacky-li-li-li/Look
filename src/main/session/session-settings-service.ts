import type { ProjectInfo, UserSettings } from "@look/shared/types";
import type { IPermissionService } from "../core/contracts.js";
import type { UserSettingsStore } from "../settings/store.js";
import type { ManagedRuntime } from "./runtime-registry.js";
import type { SessionSubagentService } from "./session-subagent-service.js";

interface ProjectTrustDefaults {
	setDefaultProjectTrust(value: "ask"): void;
}

export interface SessionSettingsServiceOptions {
	userSettings: Pick<UserSettingsStore, "getAll" | "update" | "reset">;
	listProjects(): ProjectInfo[];
	getActiveProject(): ProjectInfo | null;
	listSessionIds(): string[];
	listRuntimes(): IterableIterator<ManagedRuntime>;
	listRuntimeIds(): IterableIterator<string>;
	permissionService: Pick<IPermissionService, "setDefaultMode">;
	sessionSubagentService: Pick<SessionSubagentService, "setDefaultEnabled" | "setEnabledForSession">;
	projectTrustDefaults: ProjectTrustDefaults;
}

/** Validates persisted UI references and broadcasts cross-runtime setting changes. */
export class SessionSettingsService {
	constructor(private readonly options: SessionSettingsServiceOptions) {}

	get(): UserSettings {
		const settings = this.options.userSettings.getAll();
		const validProjectIds = new Set(this.options.listProjects().map((project) => project.id));
		const validSessionIds = new Set(this.options.listSessionIds());
		const openProjectIds = settings.openProjectIds.filter((id) => validProjectIds.has(id));
		const openedSessionIds = settings.openedSessionIds.filter((id) => validSessionIds.has(id));
		const lastActiveProjectId = validProjectIds.has(settings.lastActiveProjectId)
			? settings.lastActiveProjectId
			: (openProjectIds[0] ?? this.options.getActiveProject()?.id ?? "");
		const lastActiveSessionId = validSessionIds.has(settings.lastActiveSessionId) ? settings.lastActiveSessionId : "";
		return { ...settings, openProjectIds, openedSessionIds, lastActiveProjectId, lastActiveSessionId };
	}

	async update(partial: Partial<UserSettings>): Promise<UserSettings> {
		const validProjectIds = new Set(this.options.listProjects().map((project) => project.id));
		const validSessionIds = new Set(this.options.listSessionIds());
		const sanitized = { ...partial };
		if (sanitized.openProjectIds !== undefined) {
			sanitized.openProjectIds = sanitized.openProjectIds.filter((id) => validProjectIds.has(id));
		}
		if (sanitized.openedSessionIds !== undefined) {
			sanitized.openedSessionIds = sanitized.openedSessionIds.filter((id) => validSessionIds.has(id));
		}
		if (sanitized.lastActiveProjectId !== undefined && !validProjectIds.has(sanitized.lastActiveProjectId)) {
			sanitized.lastActiveProjectId = "";
		}
		if (sanitized.lastActiveSessionId !== undefined && !validSessionIds.has(sanitized.lastActiveSessionId)) {
			sanitized.lastActiveSessionId = "";
		}

		const settings = await this.options.userSettings.update(sanitized);
		if (sanitized.compactionEnabled !== undefined) {
			for (const managed of this.options.listRuntimes()) {
				managed.runtime.session.setAutoCompactionEnabled(sanitized.compactionEnabled);
			}
		}
		if (sanitized.permissionMode !== undefined) {
			this.options.permissionService.setDefaultMode(sanitized.permissionMode);
		}
		if (sanitized.subagentEnabled !== undefined) {
			this.options.sessionSubagentService.setDefaultEnabled(sanitized.subagentEnabled);
			await Promise.all(
				Array.from(this.options.listRuntimeIds()).map((sessionId) =>
					this.options.sessionSubagentService.setEnabledForSession(
						sessionId,
						sanitized.subagentEnabled as boolean,
					),
				),
			);
		}
		return settings;
	}

	async reset(): Promise<UserSettings> {
		const settings = await this.options.userSettings.reset();
		this.options.permissionService.setDefaultMode(settings.permissionMode);
		this.options.sessionSubagentService.setDefaultEnabled(settings.subagentEnabled);
		this.options.projectTrustDefaults.setDefaultProjectTrust("ask");
		return settings;
	}
}
