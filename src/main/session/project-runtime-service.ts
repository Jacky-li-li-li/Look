// ============================================================
// ProjectRuntimeService — project onboarding and trust reloads
//
// Owns project creation and trust changes that touch live runtimes.
// Keeps SessionRuntimeManager from owning project/runtime cross-cutting
// concerns.
// ============================================================

import fs, { existsSync } from "node:fs";
import type { ProjectInfo } from "@look/shared/types";
import type { ProjectService } from "../projects/project-service.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { SessionCatalog } from "./session-catalog.js";

export interface ProjectRuntimeServiceDependencies {
	projectService: ProjectService;
	sessionCatalog: Pick<SessionCatalog, "replace">;
	runtimeRegistry: Pick<RuntimeRegistry, "values">;
}

export class ProjectRuntimeService {
	constructor(private readonly deps: ProjectRuntimeServiceDependencies) {}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		if (!existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new Error(`Project path is not a directory: ${cwd}`);
		}
		const canonicalCwd = fs.realpathSync(cwd);
		const existing = this.deps.projectService.findByCwd(canonicalCwd);
		if (existing) {
			return { project: existing, isDuplicate: true };
		}

		const project = this.deps.projectService.createProjectRecord(canonicalCwd, name);
		this.deps.sessionCatalog.replace(project.id, []);
		this.deps.projectService.saveProjects();
		return { project, isDuplicate: false };
	}

	async setProjectTrust(projectId: string, trusted: boolean): Promise<void> {
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project ${projectId} not found`);
		this.deps.projectService.setTrust(projectId, trusted);
		const reloadPromises: Promise<void>[] = [];
		for (const managed of this.deps.runtimeRegistry.values()) {
			if (managed.runtime.cwd !== project.cwd) continue;
			reloadPromises.push(
				(async () => {
					managed.runtime.services.settingsManager.setProjectTrusted(trusted);
					await managed.runtime.session.reload();
				})(),
			);
		}
		await Promise.all(reloadPromises);
	}
}
