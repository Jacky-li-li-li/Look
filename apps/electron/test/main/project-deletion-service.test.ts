import type { ProjectInfo } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import { ProjectDeletionService } from "../../src/main/projects/project-deletion-service.js";

describe("ProjectDeletionService", () => {
	it("removes scheduled tasks bound to the deleted project", async () => {
		const project: ProjectInfo = {
			id: "project-1",
			name: "Project",
			cwd: "/tmp/project",
			createdAt: Date.now(),
			valid: true,
		};
		const deleteScheduledTasksByProject = vi.fn(async () => {});
		const service = new ProjectDeletionService({
			projectService: {
				getProjectInfo: () => project,
				removeProject: vi.fn(),
				activeId: null,
				setActiveId: vi.fn(),
				listProjects: () => [],
				saveProjects: vi.fn(),
			},
			sessionCatalog: { listByProject: () => [], removeProject: vi.fn() },
			draftIndex: { prunePersisted: vi.fn() },
			runtimeRegistry: { *entries() {} },
			disposeRuntime: vi.fn(),
			workspaceFileService: null,
			workspaceTreeService: null,
			emitSessionList: vi.fn(),
			emitProjectList: vi.fn(),
			getActiveSessionId: () => null,
			setActiveSessionId: vi.fn(),
			deleteScheduledTasksByProject,
		});

		await service.executeDelete("project-1");

		expect(deleteScheduledTasksByProject).toHaveBeenCalledWith("project-1");
	});
});
