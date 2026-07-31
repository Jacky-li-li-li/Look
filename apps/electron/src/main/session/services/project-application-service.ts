// ============================================================
// ProjectApplicationService — project router application logic
//
// Extracted from SessionRuntimeManager.{createProject, setActiveProject,
// renameProject, deleteProject} so project-router.ts depends on a narrow
// set of domain services instead of the ~50-method SessionRuntimeManager
// surface. SessionRuntimeManager keeps its own copies of this logic for
// callers that still depend on IImAgentHost / IHeadlessExecutionHost
// (IM bridge, headless scheduled-task runner) — those are out of scope
// for this migration and were intentionally left untouched.
// ============================================================

import type { ProjectInfo } from "@look/shared/types";
import type { IEventBus } from "../../core/contracts.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { SessionNotifier } from "../events/session-notifier.js";
import type { RuntimeRegistry } from "../runtime/runtime-registry.js";
import type { ProjectRuntimeService } from "./project-runtime-service.js";
import type { SessionCatalog } from "./session-catalog.js";

export interface ProjectApplicationServiceDependencies {
	projectService: Pick<ProjectService, "getProjectInfo" | "setActiveId" | "renameProject">;
	projectRuntimeService: Pick<ProjectRuntimeService, "createProject">;
	sessionCatalog: Pick<SessionCatalog, "refresh" | "listByProject">;
	runtimeRegistry: Pick<RuntimeRegistry, "entries" | "get">;
	sessionNotifier: Pick<SessionNotifier, "emitProjectList" | "emitSessionList">;
	eventBus: Pick<IEventBus, "emit">;
}

/**
 * Application service for the project domain's IPC-facing use cases:
 * create, switch (activate), rename, and request-delete. Mirrors the
 * exact behavior previously implemented directly on SessionRuntimeManager
 * so IPC payloads and observable side effects (emitted events) are
 * unchanged.
 */
export class ProjectApplicationService {
	constructor(private readonly deps: ProjectApplicationServiceDependencies) {}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		const result = await this.deps.projectRuntimeService.createProject(cwd, name);
		await this.switchProject(result.project.id);
		return result;
	}

	async switchProject(projectId: string): Promise<void> {
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project) throw new Error(`Project ${projectId} not found`);
		this.deps.projectService.setActiveId(projectId);
		if (project.valid) await this.deps.sessionCatalog.refresh(project);
		this.deps.sessionNotifier.emitProjectList();
		this.deps.eventBus.emit({ type: "project:active-changed", projectId });
		this.deps.sessionNotifier.emitSessionList(projectId);
	}

	renameProject(projectId: string, name: string): void {
		if (this.deps.projectService.renameProject(projectId, name)) {
			this.deps.sessionNotifier.emitProjectList();
		}
	}

	/** Emits a `project:confirm-delete` prompt; actual deletion happens via ProjectDeletionService. */
	requestDelete(projectId: string): void {
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project) return;
		const persisted = this.deps.sessionCatalog.listByProject(projectId);
		const runtimeIds = Array.from(this.deps.runtimeRegistry.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId ? [sessionId] : [],
		);
		this.deps.eventBus.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: project.name,
			agentCount: new Set([...persisted.map((session) => session.id), ...runtimeIds]).size,
			runningCount: runtimeIds.filter((sessionId) => {
				const session = this.deps.runtimeRegistry.get(sessionId)?.runtime.session;
				return Boolean(session && (session.isStreaming || session.isRetrying || session.isCompacting));
			}).length,
		});
	}
}
