import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as lookStorage from "../../src/main/shared/look-storage";
import { getUsage, incrementTurn, initializeUsageService, resetUsageServiceForTesting } from "../../src/main/usage-service";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function makeProject(id: string, name: string, cwd: string): { id: string; name: string; cwd: string; createdAt: number; valid: boolean } {
	return { id, name, cwd, createdAt: Date.now(), valid: true };
}

describe("usage service", () => {
	beforeEach(() => {
		resetUsageServiceForTesting();
	});

	it("returns empty usage and current year when no projects have sessions", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "look-usage-empty-"));
		cleanup.push(tempDir);
		vi.spyOn(lookStorage, "getLookDir").mockReturnValue(tempDir);

		const result = await getUsage([]);

		expect(result.usage).toEqual({});
		expect(result.years).toContain(new Date().getFullYear());
	});

	it("counts completed assistant messages from session JSONL files", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "look-usage-backfill-"));
		cleanup.push(tempDir);
		vi.spyOn(lookStorage, "getLookDir").mockReturnValue(tempDir);

		const project = makeProject("p1", "Test Project", path.join(tempDir, "project"));
		fs.mkdirSync(project.cwd, { recursive: true });
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.name);
		const date = "2026-03-15";
		const ts = new Date(`${date}T12:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session-a.jsonl"), [
			{ type: "session", version: 3, id: "session-a", timestamp: new Date(ts).toISOString(), cwd: project.cwd },
			{ id: "user-a", type: "message", message: { role: "user", content: "hi", timestamp: ts } },
			{
				id: "assistant-a",
				type: "message",
				message: { role: "assistant", content: "hello", timestamp: ts + 1000, stopReason: "stop" },
			},
		]);

		const result = await getUsage([project]);

		expect(result.usage[date]).toBe(1);
		expect(result.years).toContain(2026);
	});

	it("excludes aborted assistant messages", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "look-usage-aborted-"));
		cleanup.push(tempDir);
		vi.spyOn(lookStorage, "getLookDir").mockReturnValue(tempDir);

		const project = makeProject("p1", "Test Project", path.join(tempDir, "project"));
		fs.mkdirSync(project.cwd, { recursive: true });
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.name);
		const date = "2026-04-01";
		const ts = new Date(`${date}T10:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session-b.jsonl"), [
			{ type: "session", version: 3, id: "session-b", timestamp: new Date(ts).toISOString(), cwd: project.cwd },
			{ id: "user-b", type: "message", message: { role: "user", content: "hi", timestamp: ts } },
			{
				id: "assistant-b",
				type: "message",
				message: { role: "assistant", content: "...", timestamp: ts + 1000, stopReason: "aborted" },
			},
		]);

		const result = await getUsage([project]);

		expect(result.usage[date]).toBeUndefined();
	});

	it("increments turn count and persists it to disk", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "look-usage-increment-"));
		cleanup.push(tempDir);
		vi.spyOn(lookStorage, "getLookDir").mockReturnValue(tempDir);

		const todayKey = new Date().toLocaleDateString("en-CA");
		await initializeUsageService([]);
		incrementTurn(todayKey);
		incrementTurn(todayKey);

		const result = await getUsage([]);
		expect(result.usage[todayKey]).toBe(2);
		expect(result.years).toContain(new Date().getFullYear());
	});

	it("merges live increments with backfill without double counting", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "look-usage-merge-"));
		cleanup.push(tempDir);
		vi.spyOn(lookStorage, "getLookDir").mockReturnValue(tempDir);

		const todayKey = new Date().toLocaleDateString("en-CA");
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const yesterdayKey = yesterday.toLocaleDateString("en-CA");

		const project = makeProject("p1", "Merge Project", path.join(tempDir, "project"));
		fs.mkdirSync(project.cwd, { recursive: true });
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.name);
		const todayTs = new Date(`${todayKey}T12:00:00`).getTime();
		const yesterdayTs = new Date(`${yesterdayKey}T10:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session.jsonl"), [
			{ type: "session", version: 3, id: "session-a", timestamp: new Date(yesterdayTs).toISOString(), cwd: project.cwd },
			{
				id: "assistant-yesterday",
				type: "message",
				message: { role: "assistant", content: "yesterday", timestamp: yesterdayTs, stopReason: "stop" },
			},
			{
				id: "assistant-today",
				type: "message",
				message: { role: "assistant", content: "today", timestamp: todayTs, stopReason: "stop" },
			},
		]);

		// Simulate two live turns before the backfill has completed.
		incrementTurn(todayKey);
		incrementTurn(todayKey);

		await initializeUsageService([project]);

		const result = await getUsage([project]);
		expect(result.usage[yesterdayKey]).toBe(1);
		// Live count (2) is higher than backfilled count (1), so it should win.
		expect(result.usage[todayKey]).toBe(2);
	});
});
