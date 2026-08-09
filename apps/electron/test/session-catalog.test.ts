import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWorkspaceDir, getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import type { ProjectInfo } from "@look/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import {
	SessionCatalog,
	type StoredSession,
	scanSubsessionMetadata,
} from "../src/main/session/services/session-catalog.js";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function stored(id: string, projectId: string): StoredSession {
	return {
		id,
		projectId,
		name: id,
		firstMessage: id,
		messageCount: 1,
		created: new Date(1),
		modified: new Date(1),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp/project",
		allMessagesText: "",
	};
}

describe("SessionCatalog", () => {
	it("keeps project-local session lists and an O(1) cross-project index in sync", () => {
		const catalog = new SessionCatalog();
		catalog.replace("project-a", [stored("a-1", "project-a"), stored("a-2", "project-a")]);
		catalog.replace("project-b", [stored("b-1", "project-b")]);

		expect(catalog.listByProject("project-a").map((session) => session.id)).toEqual(["a-1", "a-2"]);
		expect(catalog.get("b-1")?.projectId).toBe("project-b");
		catalog.removeProject("project-a");
		expect(catalog.get("a-1")).toBeUndefined();
		expect(catalog.get("b-1")).toBeDefined();
	});

	it("recovers sub-session metadata without opening a pi SessionManager", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "look-subsession-catalog-"));
		cleanup.push(directory);
		const file = path.join(directory, "child.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", id: "child-1", timestamp: "2026-01-02T00:00:00.000Z" }),
				JSON.stringify({ type: "session_info", name: "Agent：review" }),
				JSON.stringify({
					type: "custom",
					customType: "look.subagent-parent.v1",
					data: { parentSessionId: "parent-1", agentName: "Agent：review" },
				}),
				JSON.stringify({ type: "message", message: { content: "Inspect the change", timestamp: 1 } }),
			].join("\n"),
		);

		expect(await scanSubsessionMetadata(file)).toMatchObject({
			sessionId: "child-1",
			displayName: "Agent：review",
			parentSessionId: "parent-1",
			messageCount: 1,
			firstMessage: "Inspect the change",
		});
	});

	it("carries persisted parent/agent markers onto discovered sub-session rows", async () => {
		const projectId = "proj-catalog-parent-1";
		const cwd = await mkdtemp(path.join(tmpdir(), "look-catalog-cwd-"));
		cleanup.push(cwd);
		const project: ProjectInfo = { id: projectId, name: "proj", cwd, createdAt: 1, valid: true };

		ensureWorkspaceDir(projectId);
		const subsessionsDir = getWorkspaceSubsessionsDir(projectId);
		fs.mkdirSync(subsessionsDir, { recursive: true });
		// 真实子会话文件名带时间戳前缀，path 必须指向该真实文件（拼接 <sessionId>.jsonl
		// 会因文件不存在导致 SessionManager.open 误生成新会话）。
		const realFileName = "2026-08-09T12-26-12-233Z_child-1.jsonl";
		fs.writeFileSync(
			path.join(subsessionsDir, realFileName),
			[
				JSON.stringify({ type: "session", id: "child-1", timestamp: "2026-01-02T00:00:00.000Z" }),
				JSON.stringify({ type: "session_info", name: "Agent：review" }),
				JSON.stringify({
					type: "custom",
					customType: "look.subagent-parent.v1",
					data: { parentSessionId: "parent-1", agentName: "Agent：review" },
				}),
				JSON.stringify({ type: "message", message: { content: "Inspect the change", timestamp: 1 } }),
			].join("\n"),
		);

		const catalog = new SessionCatalog();
		const sessions = await catalog.refresh(project);
		const child = sessions.find((session) => session.id === "child-1");
		expect(child).toBeDefined();
		expect(child).toMatchObject({
			parentSessionId: "parent-1",
			subagentAgentName: "Agent：review",
		});
		expect(child?.path).toBe(path.join(subsessionsDir, realFileName));
	});
});
