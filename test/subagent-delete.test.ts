import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectSharedDir, getWorkspaceSubsessionsDir, sanitiseWorkspaceName } from "@shared/look-storage";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session/runtime-manager.js";

/** Test-only access to SessionRuntimeManager internals. */
interface TestManagerInternals {
	sessionCatalog: { replace(projectId: string, sessions: Array<Record<string, unknown>>): void };
	subAgentRegistry: { register(parentId: string, childId: string, name: string): void };
	subAgentRuntimeService: { destroySubSessions(sessionId: string): Promise<void> };
	projectService: {
		createProjectRecord(cwd: string, name?: string): { id: string; name: string };
		has(id: string): boolean;
	};
}

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
			(manager as unknown as TestManagerInternals).sessionCatalog.replace("project-a", [
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
			(manager as unknown as TestManagerInternals).subAgentRegistry.register(
				"parent-session",
				"child-session",
				"child",
			);

			await (manager as unknown as TestManagerInternals).subAgentRuntimeService.destroySubSessions("parent-session");

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
		const projectName = `subsessions-delete-${Date.now()}`;
		const sessionsDir = join(root, "sessions");
		const sessionPath = join(sessionsDir, "session.jsonl");
		cleanup.push(root);
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(sessionPath, "", "utf8");

		const manager = new SessionRuntimeManager();
		try {
			const created = (manager as unknown as TestManagerInternals).projectService.createProjectRecord(
				root,
				projectName,
			);
			const createdId = created.id;
			const sharedDir = getProjectSharedDir(createdId);
			const actualSubsessionsDir = getWorkspaceSubsessionsDir(created.name);
			cleanup.push(sharedDir, join(actualSubsessionsDir, ".."));
			await mkdir(sharedDir, { recursive: true });
			await mkdir(actualSubsessionsDir, { recursive: true });
			await writeFile(join(actualSubsessionsDir, "child.jsonl"), "", "utf8");
			(manager as unknown as TestManagerInternals).sessionCatalog.replace(createdId, [
				{
					id: "parent-session",
					name: "parent",
					firstMessage: "",
					messageCount: 1,
					created: new Date(),
					modified: new Date(),
					path: sessionPath,
					cwd: root,
					projectId: createdId,
					allMessagesText: "",
				},
			]);

			await manager.executeDeleteProject(createdId);

			expect(existsSync(sessionPath)).toBe(false);
			expect(existsSync(sharedDir)).toBe(false);
			expect(existsSync(actualSubsessionsDir)).toBe(false);
			expect((manager as unknown as TestManagerInternals).projectService.has(createdId)).toBe(false);
			expect(sanitiseWorkspaceName(projectName)).toBe(projectName);
		} finally {
			await manager.dispose();
		}
	});
});
