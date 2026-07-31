import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import type { ProjectService } from "../src/main/projects/project-service.js";
import { ProjectRuntimeService } from "../src/main/session/services/project-runtime-service.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import type { SessionCatalog } from "../src/main/session/services/session-catalog.js";

describe("ProjectRuntimeService", () => {
	function makeProjectService(): ProjectService {
		const projects = new Map<string, ProjectInfo>();
		return {
			getProjectInfo: (id: string) => projects.get(id) ?? null,
			findByCwd: (cwd: string) => Array.from(projects.values()).find((p) => p.cwd === cwd),
			createProjectRecord: (cwd: string, name?: string) => {
				const project: ProjectInfo = {
					id: "project-1",
					name: name ?? "project",
					cwd,
					createdAt: Date.now(),
					valid: true,
				};
				projects.set(project.id, project);
				return project;
			},
			saveProjects: vi.fn(),
			setTrust: vi.fn(),
		} as unknown as ProjectService;
	}

	function makeSessionCatalog(): SessionCatalog {
		return {
			replace: vi.fn(),
		} as unknown as SessionCatalog;
	}

	function makeManagedRuntime(cwd: string): ManagedRuntime {
		return {
			runtime: {
				cwd,
				services: { settingsManager: { setProjectTrusted: vi.fn() } },
				session: { reload: vi.fn().mockResolvedValue(undefined) },
			},
			projectId: "project-1",
			cwd,
			createdAt: Date.now(),
			unsubscribe: vi.fn(),
		} as unknown as ManagedRuntime;
	}

	it("rejects non-directory project paths", async () => {
		const service = new ProjectRuntimeService({
			projectService: makeProjectService(),
			sessionCatalog: makeSessionCatalog(),
			runtimeRegistry: { values: () => [][Symbol.iterator]() },
		});
		await expect(service.createProject("/nonexistent/path")).rejects.toThrow("not a directory");
	});

	it("creates a project and seeds an empty session catalog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-prs-"));
		const projectService = makeProjectService();
		const sessionCatalog = makeSessionCatalog();
		const service = new ProjectRuntimeService({
			projectService,
			sessionCatalog,
			runtimeRegistry: { values: () => [][Symbol.iterator]() },
		});

		const result = await service.createProject(dir, "Test Project");

		expect(result.isDuplicate).toBe(false);
		expect(result.project.name).toBe("Test Project");
		expect(sessionCatalog.replace).toHaveBeenCalledWith(result.project.id, []);
		expect(projectService.saveProjects).toHaveBeenCalled();

		rmSync(dir, { recursive: true, force: true });
	});

	it("returns existing project as duplicate without modifying the catalog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-prs-dup-"));
		const projectService = makeProjectService();
		const sessionCatalog = makeSessionCatalog();
		const service = new ProjectRuntimeService({
			projectService,
			sessionCatalog,
			runtimeRegistry: { values: () => [][Symbol.iterator]() },
		});

		const first = await service.createProject(dir, "Test Project");
		const second = await service.createProject(dir, "Renamed");

		expect(second.isDuplicate).toBe(true);
		expect(second.project.id).toBe(first.project.id);
		expect(sessionCatalog.replace).toHaveBeenCalledTimes(1);

		rmSync(dir, { recursive: true, force: true });
	});

	it("reloads runtimes whose cwd matches the project on trust change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-prs-trust-"));
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "session.jsonl"), "", "utf8");

		const projectService = makeProjectService();
		const sessionCatalog = makeSessionCatalog();
		const runtimeA = makeManagedRuntime(realpathSync(dir));
		const runtimeB = makeManagedRuntime("/other/project");
		const service = new ProjectRuntimeService({
			projectService,
			sessionCatalog,
			runtimeRegistry: {
				values: () => [runtimeA, runtimeB][Symbol.iterator](),
			},
		});

		const { project } = await service.createProject(dir, "Trust Project");
		await service.setProjectTrust(project.id, true);

		expect(projectService.setTrust).toHaveBeenCalledWith(project.id, true);
		expect(runtimeA.runtime.services.settingsManager.setProjectTrusted).toHaveBeenCalledWith(true);
		expect(runtimeA.runtime.session.reload).toHaveBeenCalled();
		expect(runtimeB.runtime.services.settingsManager.setProjectTrusted).not.toHaveBeenCalled();
		expect(runtimeB.runtime.session.reload).not.toHaveBeenCalled();

		rmSync(dir, { recursive: true, force: true });
	});
});
