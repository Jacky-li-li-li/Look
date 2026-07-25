import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "look-shared-test-"));

beforeEach(() => {
	process.env.LOOK_HOME = testHome;
	vi.resetModules();
});

afterEach(() => {
	try {
		fs.rmSync(testHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	delete process.env.LOOK_HOME;
});

async function importModule() {
	return await import("../src/look-storage");
}

describe("look-storage path functions", () => {
	it("getLookDir returns LOOK_HOME", async () => {
		const { getLookDir } = await importModule();
		expect(getLookDir()).toBe(testHome);
	});

	it("getAuthPath returns path under LOOK_HOME", async () => {
		const { getAuthPath } = await importModule();
		expect(getAuthPath()).toBe(path.join(testHome, "auth.json"));
	});

	it("getModelsPath returns path under LOOK_HOME", async () => {
		const { getModelsPath } = await importModule();
		expect(getModelsPath()).toBe(path.join(testHome, "models.json"));
	});

	it("getCustomProvidersPath returns path under LOOK_HOME", async () => {
		const { getCustomProvidersPath } = await importModule();
		expect(getCustomProvidersPath()).toBe(path.join(testHome, "custom-providers.json"));
	});

	it("getSettingsPath returns path under LOOK_HOME", async () => {
		const { getSettingsPath } = await importModule();
		expect(getSettingsPath()).toBe(path.join(testHome, "settings.json"));
	});

	it("getUiSettingsPath returns path under LOOK_HOME", async () => {
		const { getUiSettingsPath } = await importModule();
		expect(getUiSettingsPath()).toBe(path.join(testHome, "ui-settings.json"));
	});

	it("getProjectsIndexPath returns path under LOOK_HOME", async () => {
		const { getProjectsIndexPath } = await importModule();
		expect(getProjectsIndexPath()).toBe(path.join(testHome, "projects.json"));
	});

	it("getProjectDir returns project-specific directory", async () => {
		const { getProjectDir } = await importModule();
		expect(getProjectDir("test-project")).toBe(path.join(testHome, "projects", "test-project"));
	});

	it("getProjectSystemPromptPath returns SYSTEM.md under project dir", async () => {
		const { getProjectSystemPromptPath } = await importModule();
		expect(getProjectSystemPromptPath("test-project")).toBe(
			path.join(testHome, "projects", "test-project", "SYSTEM.md"),
		);
	});

	it("getSystemPromptPath returns SYSTEM.md at root", async () => {
		const { getSystemPromptPath } = await importModule();
		expect(getSystemPromptPath()).toBe(path.join(testHome, "SYSTEM.md"));
	});

	it("getWorkspacesDir returns path under LOOK_HOME", async () => {
		const { getWorkspacesDir } = await importModule();
		expect(getWorkspacesDir()).toBe(path.join(testHome, "workspaces"));
	});

	it("getWorkspaceDir returns project-specific workspace", async () => {
		const { getWorkspaceDir } = await importModule();
		expect(getWorkspaceDir("test-project")).toBe(path.join(testHome, "workspaces", "test-project"));
	});

	it("getWorkspaceSessionsDir returns sessions under workspace", async () => {
		const { getWorkspaceSessionsDir } = await importModule();
		expect(getWorkspaceSessionsDir("test-project")).toBe(
			path.join(testHome, "workspaces", "test-project", "sessions"),
		);
	});

	it("getWorkspaceSubsessionsDir returns subsessions under workspace", async () => {
		const { getWorkspaceSubsessionsDir } = await importModule();
		expect(getWorkspaceSubsessionsDir("test-project")).toBe(
			path.join(testHome, "workspaces", "test-project", "subsessions"),
		);
	});

	it("ensureLookDir creates the directory", async () => {
		const { ensureLookDir, getLookDir } = await importModule();
		expect(fs.existsSync(getLookDir())).toBe(false);
		ensureLookDir();
		expect(fs.existsSync(getLookDir())).toBe(true);
	});

	it("ensureProjectDir creates and returns project directory", async () => {
		const { ensureProjectDir, getProjectDir } = await importModule();
		const dir = getProjectDir("test-project");
		expect(fs.existsSync(dir)).toBe(false);
		const result = ensureProjectDir("test-project");
		expect(result).toBe(dir);
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("getScheduledTasksPath returns path under LOOK_HOME", async () => {
		const { getScheduledTasksPath } = await importModule();
		expect(getScheduledTasksPath()).toBe(path.join(testHome, "scheduled-tasks.json"));
	});

	it("getScheduledTaskLocksDir returns path under LOOK_HOME", async () => {
		const { getScheduledTaskLocksDir } = await importModule();
		expect(getScheduledTaskLocksDir()).toBe(path.join(testHome, "scheduled-task-locks"));
	});

	it("getUserProfilePath returns path under LOOK_HOME", async () => {
		const { getUserProfilePath } = await importModule();
		expect(getUserProfilePath()).toBe(path.join(testHome, "user-profile.json"));
	});

	it("sanitiseWorkspaceName replaces invalid characters", async () => {
		const { sanitiseWorkspaceName } = await importModule();
		expect(sanitiseWorkspaceName("test/project")).toBe("test-project");
		expect(sanitiseWorkspaceName("normal-name")).toBe("normal-name");
		expect(sanitiseWorkspaceName("spaces are ok")).toBe("spaces are ok");
	});

	it("getDefaultWorkspaceCwd returns path under LOOK_HOME", async () => {
		const { getDefaultWorkspaceCwd } = await importModule();
		expect(getDefaultWorkspaceCwd()).toBe(path.join(testHome, "default-workspace"));
	});
});

describe("look-storage LOOK_HOME fallback", () => {
	// 仅断言路径字符串，不触碰真实 ~/.look 下的任何文件。
	it("falls back to ~/.look when LOOK_HOME is not set", async () => {
		delete process.env.LOOK_HOME;
		vi.resetModules();
		const { getLookDir } = await importModule();
		expect(getLookDir()).toBe(path.join(os.homedir(), ".look"));
	});
});
