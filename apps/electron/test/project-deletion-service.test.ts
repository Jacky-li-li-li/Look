// ============================================================
// ProjectDeletionService unit tests
// ============================================================

import type { ProjectInfo } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import type { IEventBus } from "../src/main/core/contracts.js";
import { ProjectDeletionService } from "../src/main/projects/project-deletion-service.js";
import type { ProjectService } from "../src/main/projects/project-service.js";
import type { RuntimeRegistry } from "../src/main/session/runtime/runtime-registry.js";
import type { SessionCatalog, StoredSession } from "../src/main/session/services/session-catalog.js";
import type { WorkspaceFileService } from "../src/main/workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../src/main/workspace/workspace-tree-service.js";

function makeStoredSession(id: string, projectId: string): StoredSession {
	return {
		id,
		name: "test",
		firstMessage: "",
		messageCount: 0,
		created: new Date(),
		modified: new Date(),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId,
		allMessagesText: "",
	};
}

describe("ProjectDeletionService", () => {
	it("disposes runtimes, stops watchers, removes catalog/project, and emits lists", async () => {
		const projectId = "proj-1";
		const project: ProjectInfo = { id: projectId, name: "p1", cwd: "/tmp/p1", createdAt: 1, valid: true };
		const disposed: string[] = [];
		const events: unknown[] = [];

		const projectService = {
			getProjectInfo: vi.fn((id: string) => (id === projectId ? project : null)),
			removeProject: vi.fn(),
			activeId: projectId,
			setActiveId: vi.fn(),
			listProjects: vi.fn(() => []),
			saveProjects: vi.fn(),
		} as unknown as Pick<
			ProjectService,
			"getProjectInfo" | "removeProject" | "activeId" | "setActiveId" | "listProjects" | "saveProjects"
		>;

		const sessionCatalog = {
			listByProject: vi.fn(() => [makeStoredSession("s1", projectId)]),
			removeProject: vi.fn(),
		} as unknown as Pick<SessionCatalog, "listByProject" | "removeProject">;

		const runtimeRegistry = {
			entries: vi.fn(() => new Map<string, unknown>().entries()),
		} as unknown as Pick<RuntimeRegistry, "entries">;

		const _eventBus = { emit: vi.fn((e: unknown) => events.push(e)) } as unknown as IEventBus;

		const workspaceFileService = {
			stopWatching: vi.fn(),
		} as unknown as WorkspaceFileService;

		const workspaceTreeService = {
			stopAllWatchesForProject: vi.fn(),
		} as unknown as WorkspaceTreeService;

		const service = new ProjectDeletionService({
			projectService,
			sessionCatalog,
			draftIndex: { prunePersisted: vi.fn() },
			runtimeRegistry,
			disposeRuntime: async (sessionId: string) => disposed.push(sessionId),
			workspaceFileService,
			workspaceTreeService,
			emitSessionList: (id: string) => events.push({ type: "agent:list", projectId: id }),
			emitProjectList: () => events.push({ type: "project:list" }),
			getActiveSessionId: () => null,
			setActiveSessionId: () => {},
			attachments: {
				deleteProjectAttachments: vi.fn(),
			} as unknown as import("../src/main/session/services/attachment-service.js").AttachmentService,
		});

		await service.executeDelete(projectId);

		expect(projectService.removeProject).toHaveBeenCalledWith(projectId);
		expect(sessionCatalog.removeProject).toHaveBeenCalledWith(projectId);
		expect(workspaceFileService.stopWatching).toHaveBeenCalledWith(projectId);
		expect(workspaceTreeService.stopAllWatchesForProject).toHaveBeenCalledWith(projectId);
		expect(projectService.saveProjects).toHaveBeenCalled();
		expect(events).toContainEqual({ type: "agent:list", projectId });
		expect(events).toContainEqual({ type: "project:list" });
	});

	it("rejects an unknown project before deriving or deleting storage paths", async () => {
		const removeProject = vi.fn();
		const removeCatalogProject = vi.fn();
		const service = new ProjectDeletionService({
			projectService: {
				getProjectInfo: vi.fn(() => null),
				removeProject,
				activeId: null,
				setActiveId: vi.fn(),
				listProjects: vi.fn(() => []),
				saveProjects: vi.fn(),
			} as unknown as Pick<
				ProjectService,
				"getProjectInfo" | "removeProject" | "activeId" | "setActiveId" | "listProjects" | "saveProjects"
			>,
			sessionCatalog: {
				draftIndex: { prunePersisted: vi.fn() },
				listByProject: vi.fn(() => []),
				removeProject: removeCatalogProject,
			} as unknown as Pick<SessionCatalog, "listByProject" | "removeProject">,
			runtimeRegistry: { entries: vi.fn(() => new Map<string, unknown>().entries()) } as unknown as Pick<
				RuntimeRegistry,
				"entries"
			>,
			disposeRuntime: vi.fn(),
			workspaceFileService: null,
			workspaceTreeService: null,
			emitSessionList: vi.fn(),
			emitProjectList: vi.fn(),
			getActiveSessionId: () => null,
			setActiveSessionId: vi.fn(),
			attachments: {
				deleteProjectAttachments: vi.fn(),
			} as unknown as import("../src/main/session/services/attachment-service.js").AttachmentService,
		});

		await expect(service.executeDelete("../escape")).rejects.toThrow("Invalid project ID");
		expect(removeProject).not.toHaveBeenCalled();
		expect(removeCatalogProject).not.toHaveBeenCalled();
	});

	it("clears active session id when it belongs to the deleted project", async () => {
		const projectId = "proj-2";
		const sessionId = "s2";
		let activeSessionId: string | null = sessionId;

		const runtimeRegistry = {
			entries: vi.fn(() => {
				const map = new Map<string, { projectId: string }>();
				map.set(sessionId, { projectId });
				return map.entries();
			}),
		} as unknown as Pick<RuntimeRegistry, "entries">;

		const service = new ProjectDeletionService({
			projectService: {
				getProjectInfo: () => ({ id: projectId, name: "p2", cwd: "/tmp", createdAt: 1, valid: true }),
				removeProject: vi.fn(),
				activeId: projectId,
				setActiveId: vi.fn(),
				listProjects: vi.fn(() => []),
				saveProjects: vi.fn(),
			} as unknown as Pick<
				ProjectService,
				"getProjectInfo" | "removeProject" | "activeId" | "setActiveId" | "listProjects" | "saveProjects"
			>,
			sessionCatalog: { listByProject: vi.fn(() => []), removeProject: vi.fn() } as unknown as Pick<
				SessionCatalog,
				"listByProject" | "removeProject"
			>,
			draftIndex: { prunePersisted: vi.fn() },
			runtimeRegistry,
			disposeRuntime: vi.fn(),
			workspaceFileService: null,
			workspaceTreeService: null,
			emitSessionList: vi.fn(),
			emitProjectList: vi.fn(),
			getActiveSessionId: () => activeSessionId,
			setActiveSessionId: (id: string | null) => {
				activeSessionId = id;
			},
			attachments: {
				deleteProjectAttachments: vi.fn(),
			} as unknown as import("../src/main/session/services/attachment-service.js").AttachmentService,
		});

		await service.executeDelete(projectId);
		expect(activeSessionId).toBeNull();
	});
});
