import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectInfo } from "@look/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ sessionsDir: "", subsessionsDir: "" }));

vi.mock("@look/shared/look-storage", () => ({
	ensureWorkspaceDir: () => storage.sessionsDir,
	getWorkspaceSubsessionsDir: () => storage.subsessionsDir,
}));

import { SessionCatalog } from "../src/main/session/services/session-catalog.js";
import { SubAgentRegistry } from "../src/main/session/subagent-registry.js";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session infrastructure integration", () => {
	it("recovers durable parent-child links into the in-memory registry during catalog refresh", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "look-session-infrastructure-"));
		cleanup.push(root);
		storage.sessionsDir = path.join(root, "sessions");
		storage.subsessionsDir = path.join(root, "subsessions");
		fs.mkdirSync(storage.sessionsDir);
		fs.mkdirSync(storage.subsessionsDir);
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd);
		fs.writeFileSync(
			path.join(storage.sessionsDir, "parent.jsonl"),
			[
				JSON.stringify({ type: "session", id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
				JSON.stringify({ type: "message", message: { role: "user", content: "parent", timestamp: 1 } }),
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(storage.subsessionsDir, "child.jsonl"),
			[
				JSON.stringify({ type: "session", id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
				JSON.stringify({
					type: "custom",
					customType: "look.subagent-parent.v1",
					data: { parentSessionId: "parent", agentName: "Agent：review" },
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "child", timestamp: 2 } }),
			].join("\n"),
		);

		const subagents = new SubAgentRegistry();
		const catalog = new SessionCatalog((metadata) => {
			if (metadata.parentSessionId) {
				subagents.register(metadata.parentSessionId, metadata.sessionId, metadata.agentName ?? "");
			}
		});
		const project: ProjectInfo = { id: "project-a", name: "Project A", cwd, createdAt: Date.now(), valid: true };
		const sessions = await catalog.refresh(project);

		expect(sessions.map((session) => session.id).sort()).toEqual(["child", "parent"]);
		expect(catalog.get("child")?.projectId).toBe("project-a");
		expect(subagents.getParent("child")).toBe("parent");
		expect(subagents.listChildren("parent")).toEqual(["child"]);
	});
});
