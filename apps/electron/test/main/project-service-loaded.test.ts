import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const makeSettingsManager = () =>
	({
		getDefaultProjectTrust: () => "ask",
		get: () => undefined,
		set: () => {},
	}) as unknown as import("@earendil-works/pi-coding-agent").SettingsManager;

const makeTrustStore = () =>
	({
		get: () => null,
		set: () => {},
	}) as unknown as import("@earendil-works/pi-coding-agent").ProjectTrustStore;

describe("ProjectService whenProjectsLoaded", () => {
	let tempDir: string;
	const cleanup: string[] = [];

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "look-project-loaded-"));
		cleanup.push(tempDir);
		vi.stubEnv("LOOK_HOME", tempDir);
		vi.resetModules();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
	});

	it("stays pending before loadProjects and resolves after", async () => {
		const { ProjectService } = await import("../../src/main/projects/project-service.js");
		const service = new ProjectService(makeTrustStore(), makeSettingsManager());

		let resolved = false;
		void service.whenProjectsLoaded().then(() => {
			resolved = true;
		});
		await new Promise((r) => setImmediate(r));
		expect(resolved).toBe(false);

		await service.loadProjects();
		await service.whenProjectsLoaded();
		expect(resolved).toBe(true);
		// 加载完成后项目列表不为空（默认工作区保证至少一项）。
		expect(service.listProjects().length).toBeGreaterThan(0);
	});
});
