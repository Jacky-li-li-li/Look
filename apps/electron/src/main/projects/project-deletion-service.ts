// ============================================================
// ProjectDeletionService — durable project cleanup orchestration
//
// Owns the cross-domain transaction of deleting a project: disposing
// live runtimes, deleting session JSONL files, stopping workspace
// watchers, removing project indexes, and cleaning workspace/shared
// directories. Keeps ProjectService focused on project records alone.
// ============================================================

import fs, { existsSync } from "node:fs";
import { getProjectSharedDir, getWorkspaceDir } from "@look/shared/look-storage";
import { DEFAULT_PROJECT_ID } from "@look/shared/types";
import type { RuntimeRegistry } from "../session/runtime/runtime-registry.js";
import type { SessionCatalog } from "../session/services/session-catalog.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import type { ProjectService } from "./project-service.js";

export interface ProjectDeletionDependencies {
	projectService: Pick<
		ProjectService,
		"getProjectInfo" | "removeProject" | "activeId" | "setActiveId" | "listProjects" | "saveProjects"
	>;
	sessionCatalog: Pick<SessionCatalog, "listByProject" | "removeProject">;
	runtimeRegistry: Pick<RuntimeRegistry, "entries">;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	workspaceFileService: WorkspaceFileService | null;
	workspaceTreeService: WorkspaceTreeService | null;
	emitSessionList(projectId: string): void;
	emitProjectList(): void;
	getActiveSessionId(): string | null;
	setActiveSessionId(id: string | null): void;
	/** Optional hook to remove scheduled tasks bound to the deleted project. */
	deleteScheduledTasksByProject?(projectId: string): Promise<void>;
}

export class ProjectDeletionService {
	constructor(private readonly deps: ProjectDeletionDependencies) {}

	async executeDelete(projectId: string): Promise<void> {
		const project = this.deps.projectService.getProjectInfo(projectId);
		const sessions = this.deps.sessionCatalog.listByProject(projectId);
		const runtimeIds: string[] = [];
		for (const [sessionId, managed] of this.deps.runtimeRegistry.entries()) {
			if (managed.projectId === projectId) runtimeIds.push(sessionId);
		}
		const sharedDir = getProjectSharedDir(projectId);
		const workspaceDir = project ? getWorkspaceDir(project.id) : null;

		await Promise.all(runtimeIds.map((sessionId) => this.deps.disposeRuntime(sessionId, true)));

		// Stop watchers before deleting directories to avoid chokidar errors on deleted inodes.
		if (this.deps.workspaceFileService) {
			try {
				await this.deps.workspaceFileService.stopWatching(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop shared area watcher for ${projectId}:`, error);
			}
		}
		if (this.deps.workspaceTreeService) {
			try {
				await this.deps.workspaceTreeService.stopAllWatchesForProject(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop workspace tree watchers for ${projectId}:`, error);
			}
		}

		for (const session of sessions) {
			try {
				fs.unlinkSync(session.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
		}

		this.deps.sessionCatalog.removeProject(projectId);
		this.deps.projectService.removeProject(projectId);
		if (this.deps.deleteScheduledTasksByProject) {
			try {
				await this.deps.deleteScheduledTasksByProject(projectId);
			} catch (error) {
				console.error(`[Look] Failed to clean up scheduled tasks for deleted project ${projectId}:`, error);
			}
		}

		// Remove shared area and the entire workspace directory (sessions/subsessions/schedule-sessions).
		if (existsSync(sharedDir)) {
			try {
				fs.rmSync(sharedDir, { recursive: true, force: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					console.error(`Failed to remove shared area for project ${projectId}:`, error);
				}
			}
		}
		if (workspaceDir && existsSync(workspaceDir)) {
			try {
				fs.rmSync(workspaceDir, { recursive: true, force: true });
				if (project) {
					console.log(`[Look] Removed workspace for deleted project "${project.name}" (${projectId})`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					console.error(`Failed to remove workspace for project ${projectId}:`, error);
				}
			}
		}

		const activeSessionId = this.deps.getActiveSessionId();
		if (activeSessionId && runtimeIds.includes(activeSessionId)) {
			this.deps.setActiveSessionId(null);
		}
		if (this.deps.projectService.activeId === projectId) {
			const fallback = this.deps.projectService.listProjects().find((p) => p.valid && p.id !== DEFAULT_PROJECT_ID);
			if (fallback) {
				this.deps.projectService.setActiveId(fallback.id);
			} else {
				this.deps.projectService.setActiveId(DEFAULT_PROJECT_ID);
			}
		}

		this.deps.projectService.saveProjects();
		this.deps.emitSessionList(projectId);
		this.deps.emitProjectList();
		if (this.deps.projectService.activeId) {
			this.deps.emitSessionList(this.deps.projectService.activeId);
		}
	}
}
