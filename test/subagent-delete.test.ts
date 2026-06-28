import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session-runtime-manager";
import {
	getProjectSharedDir,
	getWorkspaceSubsessionsDir,
	sanitiseWorkspaceName,
} from "../src/main/shared/look-storage";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SubAgent deletion cleanup", () => {
	it("deletes stored child session files even when the child runtime is not live", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-subagent-delete-"));
		cleanup.push(root);
		const childPath = join(root, "child.jsonl");
		await writeFile(childPath, "", "utf8");

		const manager = new SessionRuntimeManager();
		const events: string[] = [];
		const unsubscribe = manager.onEvent((event) => {
			if (event.type === "agent:destroyed") events.push(event.agentId);
		});
		try {
			(manager as any).sessionsByProject.set("project-a", [
				{
					id: "child-session",
					name: "child",
					firstMessage: "",
					messageCount: 1,
					created: new Date(),
					modified: new Date(),
					path: childPath,
					cwd: root,
					projectId: "project-a",
					allMessagesText: "",
				},
			]);
			(manager as any).subSessionRegistry.set("parent-session", new Set(["child-session"]));
			(manager as any).subSessionMeta.set("child-session", {
				parentSessionId: "parent-session",
				agentName: "child",
			});

			await (manager as any).destroySubSessions("parent-session");

			expect(existsSync(childPath)).toBe(false);
			expect(manager.listSubSessions("parent-session")).toEqual([]);
			expect(events).toContain("child-session");
		} finally {
			unsubscribe();
			await manager.dispose();
		}
	});

	it("deletes a project's subsessions directory when the project is removed", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-project-delete-"));
		const projectId = `test-${Date.now()}`;
		const projectName = `subsessions-delete-${Date.now()}`;
		const sessionsDir = join(root, "sessions");
		const sessionPath = join(sessionsDir, "session.jsonl");
		const sharedDir = getProjectSharedDir(projectId);
		const subsessionsDir = getWorkspaceSubsessionsDir(projectName);
		cleanup.push(root, sharedDir, join(subsessionsDir, ".."));
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(sharedDir, { recursive: true });
		await mkdir(subsessionsDir, { recursive: true });
		await writeFile(sessionPath, "", "utf8");
		await writeFile(join(subsessionsDir, "child.jsonl"), "", "utf8");

		const manager = new SessionRuntimeManager();
		try {
			(manager as any).projectsIndexPath = join(root, "projects.json");
			(manager as any).projects.set(projectId, {
				id: projectId,
				name: projectName,
				cwd: root,
				createdAt: Date.now(),
				valid: true,
			});
			(manager as any).sessionsByProject.set(projectId, [
				{
					id: "parent-session",
					name: "parent",
					firstMessage: "",
					messageCount: 1,
					created: new Date(),
					modified: new Date(),
					path: sessionPath,
					cwd: root,
					projectId,
					allMessagesText: "",
				},
			]);

			await manager.executeDeleteProject(projectId);

			expect(existsSync(sessionPath)).toBe(false);
			expect(existsSync(sharedDir)).toBe(false);
			expect(existsSync(subsessionsDir)).toBe(false);
			expect((manager as any).projects.has(projectId)).toBe(false);
			expect(sanitiseWorkspaceName(projectName)).toBe(projectName);
		} finally {
			await manager.dispose();
		}
	});
});
