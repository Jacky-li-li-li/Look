// ============================================================
// Settings validation — openedSessionIds / lastActiveSessionId
// must be filtered to IDs that actually exist in the session catalog.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Test-only access to SessionRuntimeManager internals. */
interface TestManagerInternals {
	runtimeRegistry: {
		set(
			sessionId: string,
			runtime: {
				runtime: { session: Record<string, unknown> };
				projectId: string;
				cwd: string;
				createdAt: number;
				binding: { sessionId: string; sessionManager: Record<string, unknown> };
				unsubscribe: () => void;
			},
		): void;
		delete(sessionId: string): boolean;
	};
}

function installFakeRuntime(
	manager: import("../src/main/session/runtime-manager.js").SessionRuntimeManager,
	sessionId: string,
	projectId: string,
) {
	const sessionManager = { getSessionName: () => "fake", isPersisted: () => false };
	const session = {
		getSessionStats: () => ({ totalMessages: 0 }),
		model: null,
		thinkingLevel: "off",
		supportsThinking: () => false,
		getAvailableThinkingLevels: () => ["off"],
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		getContextUsage: () => undefined,
		dispose: () => Promise.resolve(),
		sessionManager,
	};
	(manager as unknown as TestManagerInternals).runtimeRegistry.set(sessionId, {
		runtime: { session, dispose: () => Promise.resolve() } as unknown as Record<string, unknown>,
		projectId,
		cwd: "/project",
		createdAt: Date.now(),
		binding: { sessionId, sessionManager },
		unsubscribe: () => {},
	});
}

describe("Settings session/project reference validation", () => {
	let lookDir: string;
	let manager: import("../src/main/session/runtime-manager.js").SessionRuntimeManager;

	beforeEach(async () => {
		lookDir = mkdtempSync(join(tmpdir(), "look-settings-validation-"));
		vi.stubEnv("LOOK_HOME", lookDir);
		vi.resetModules();
		const { SessionRuntimeManager } = await import("../src/main/session/runtime-manager.js");
		manager = new SessionRuntimeManager();
		await manager.initAsync();
	});

	afterEach(async () => {
		await manager.dispose();
		vi.unstubAllEnvs();
		rmSync(lookDir, { recursive: true, force: true });
	});

	it("filters stale openedSessionIds and lastActiveSessionId from persisted settings", async () => {
		// Simulate stale persisted settings.
		await manager.updateGeneralSettings({
			lastActiveSessionId: "stale-session",
			openedSessionIds: ["stale-session", "also-stale"],
			lastActiveProjectId: "stale-project",
			openProjectIds: ["stale-project"],
		});

		// No projects/sessions exist yet, so all references should be filtered out.
		const settings = manager.getGeneralSettings();
		expect(settings.lastActiveSessionId).toBe("");
		expect(settings.openedSessionIds).toEqual([]);
		expect(settings.lastActiveProjectId).toBe("");
		expect(settings.openProjectIds).toEqual([]);
	});

	it("keeps only references that match live runtimes", async () => {
		const projectDir = mkdtempSync(join(lookDir, "project-"));
		mkdirSync(projectDir, { recursive: true });
		const { project } = await manager.createProject(projectDir, "test-project");

		installFakeRuntime(manager, "live-session", project.id);

		await manager.updateGeneralSettings({
			lastActiveSessionId: "stale-session",
			openedSessionIds: ["stale-session", "live-session"],
		});

		const settings = manager.getGeneralSettings();
		expect(settings.lastActiveSessionId).toBe("");
		expect(settings.openedSessionIds).toEqual(["live-session"]);
	});
});
