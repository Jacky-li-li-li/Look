import fs from "node:fs";
import fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const makeSettingsManager = () =>
	({
		getDefaultProjectTrust: () => "ask",
		get: () => undefined,
		set: () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").SettingsManager);

const makeTrustStore = () =>
	({
		get: () => null,
		set: () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").ProjectTrustStore);

function writeSessionJsonl(filePath: string, sessionId: string, cwd: string) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd,
		}) + "\n",
	);
}

describe("ProjectService workspace migration", () => {
	let tempDir: string;
	let cleanup: string[] = [];

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "look-project-service-"));
		cleanup.push(tempDir);
		vi.stubEnv("LOOK_HOME", tempDir);
		vi.resetModules();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
	});

	it("uses projectId (not name) for workspace directories", async () => {
		const lookStorage = await import("@look/shared/look-storage");
		const projectId = "proj-123";
		const name = "My Project / v1";
		expect(lookStorage.getWorkspaceDir(projectId)).toBe(path.join(tempDir, "workspaces", projectId));
		expect(lookStorage.getWorkspaceDir(projectId)).not.toContain(name);
	});

	it("migrates a name-based workspace dir to a projectId-based dir on recovery", async () => {
		const [{ ProjectService }, lookStorage] = await Promise.all([
			import("../../src/main/projects/project-service.js"),
			import("@look/shared/look-storage"),
		]);
		const service = new ProjectService(makeTrustStore(), makeSettingsManager());
		const cwd = path.join(tempDir, "my-cwd");
		fs.mkdirSync(cwd, { recursive: true });

		const project = (service as unknown as { createProjectRecord(cwd: string, name: string): { id: string } }).createProjectRecord(cwd, "legacy/name");

		const legacyDir = path.join(tempDir, "workspaces", "legacy-name");
		writeSessionJsonl(path.join(legacyDir, "sessions", "session-a.jsonl"), "session-a", cwd);

		const migrated = await service.recoverOrphanedProjects();
		expect(migrated).toBe(true);

		const newDir = lookStorage.getWorkspaceDir(project.id);
		expect(fs.existsSync(newDir)).toBe(true);
		expect(fs.existsSync(path.join(newDir, "sessions", "session-a.jsonl"))).toBe(true);
		expect(fs.existsSync(legacyDir)).toBe(false);
	});

	it("merges colliding workspace dirs instead of overwriting", async () => {
		const [{ ProjectService }, lookStorage] = await Promise.all([
			import("../../src/main/projects/project-service.js"),
			import("@look/shared/look-storage"),
		]);
		const service = new ProjectService(makeTrustStore(), makeSettingsManager());
		const cwd = path.join(tempDir, "my-cwd");
		fs.mkdirSync(cwd, { recursive: true });

		const project = (service as unknown as { createProjectRecord(cwd: string, name: string): { id: string } }).createProjectRecord(cwd, "collide");

		const legacyDir = path.join(tempDir, "workspaces", "collide");
		const newDir = lookStorage.getWorkspaceDir(project.id);
		writeSessionJsonl(path.join(legacyDir, "sessions", "legacy.jsonl"), "legacy", cwd);
		writeSessionJsonl(path.join(newDir, "sessions", "existing.jsonl"), "existing", cwd);

		const migrated = await service.recoverOrphanedProjects();
		expect(migrated).toBe(true);

		expect(fs.existsSync(path.join(newDir, "sessions", "existing.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(newDir, "sessions", "legacy.jsonl"))).toBe(true);
		expect(fs.existsSync(legacyDir)).toBe(false);
	});

	it("recovers a true orphan into a projectId-based directory", async () => {
		const [{ ProjectService }, lookStorage] = await Promise.all([
			import("../../src/main/projects/project-service.js"),
			import("@look/shared/look-storage"),
		]);
		const service = new ProjectService(makeTrustStore(), makeSettingsManager());
		const cwd = path.join(tempDir, "orphan-cwd");
		fs.mkdirSync(cwd, { recursive: true });

		const orphanDir = path.join(tempDir, "workspaces", "orphan-project");
		writeSessionJsonl(path.join(orphanDir, "sessions", "orphan.jsonl"), "orphan", cwd);

		const migrated = await service.recoverOrphanedProjects();
		expect(migrated).toBe(true);

		const realCwd = await fsp.realpath(cwd);
		const projects = service.listProjects();
		const recovered = projects.find((p) => p.cwd === realCwd);
		expect(recovered).toBeDefined();
		expect(fs.existsSync(lookStorage.getWorkspaceDir(recovered!.id))).toBe(true);
	});
});
