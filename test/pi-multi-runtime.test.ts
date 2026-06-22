import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pi multi-runtime host constraints", () => {
	it("keeps two runtime instances and cwd-bound services independent", async () => {
		const roots = await Promise.all([
			mkdtemp(join(tmpdir(), "look-runtime-a-")),
			mkdtemp(join(tmpdir(), "look-runtime-b-")),
		]);
		cleanup.push(...roots);
		const factory = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
			const services = await createAgentSessionServices({ cwd, agentDir: cwd });
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimes = await Promise.all(
			roots.map((cwd) =>
				createAgentSessionRuntime(factory, {
					cwd,
					agentDir: cwd,
					sessionManager: SessionManager.inMemory(cwd),
				}),
			),
		);
		try {
			expect(runtimes[0]).not.toBe(runtimes[1]);
			expect(runtimes[0].session.sessionId).not.toBe(runtimes[1].session.sessionId);
			expect(runtimes.map((runtime) => runtime.cwd)).toEqual(roots);
		} finally {
			await Promise.all(runtimes.map((runtime) => runtime.dispose()));
		}
	});

	it("persists completed sessions separately and leaves empty drafts unlisted", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-session-files-"));
		cleanup.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		await Promise.all([import("node:fs/promises").then(({ mkdir }) => mkdir(cwd)), import("node:fs/promises").then(({ mkdir }) => mkdir(sessionDir))]);

		const first = SessionManager.create(cwd, sessionDir);
		const second = SessionManager.create(cwd, sessionDir);
		const emptyDraft = SessionManager.create(cwd, sessionDir);
		for (const manager of [first, second]) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "persisted" }],
				timestamp: Date.now(),
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
			} as any);
		}

		const listed = await SessionManager.list(cwd, sessionDir);
		expect(listed.map((session) => session.id).sort()).toEqual([first.getSessionId(), second.getSessionId()].sort());
		expect(first.getSessionFile()).not.toBe(second.getSessionFile());
		expect(existsSync(emptyDraft.getSessionFile()!)).toBe(false);
	});
});
