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
		const factory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}: {
			cwd: string;
			sessionManager: SessionManager;
			sessionStartEvent: unknown;
		}) => {
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
		await Promise.all([
			import("node:fs/promises").then(({ mkdir }) => mkdir(cwd)),
			import("node:fs/promises").then(({ mkdir }) => mkdir(sessionDir)),
		]);

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
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
		}

		const listed = await SessionManager.list(cwd, sessionDir);
		expect(listed.map((session) => session.id).sort()).toEqual([first.getSessionId(), second.getSessionId()].sort());
		expect(first.getSessionFile()).not.toBe(second.getSessionFile());
		expect(existsSync(emptyDraft.getSessionFile()!)).toBe(false);
	});

	it("branches through an independent manager without mutating the source manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "look-parallel-fork-"));
		cleanup.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		const { mkdir } = await import("node:fs/promises");
		await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
		const source = SessionManager.create(cwd, sessionDir);
		const entryId = source.appendMessage({ role: "user", content: "fork here", timestamp: Date.now() });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persist the source" }],
			timestamp: Date.now(),
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
		const sourceId = source.getSessionId();
		const sourceFile = source.getSessionFile()!;
		const sourceLeaf = source.getLeafId();

		const copy = SessionManager.open(sourceFile, source.getSessionDir());
		const forkedPath = copy.createBranchedSession(entryId)!;

		expect(copy.getSessionId()).not.toBe(sourceId);
		expect(forkedPath).not.toBe(sourceFile);
		expect(source.getSessionId()).toBe(sourceId);
		expect(source.getSessionFile()).toBe(sourceFile);
		expect(source.getLeafId()).toBe(sourceLeaf);
		expect(source.getEntry(entryId)).toBeDefined();
	});
});
