import fs from "node:fs";
import path from "node:path";
import * as lookStorage from "@shared/look-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUsage, markUsageDirty, resetUsageServiceForTesting } from "../../src/main/system/usage-service.js";

afterEach(() => {
	vi.restoreAllMocks();
});

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function makeProject(
	id: string,
	name: string,
): { id: string; name: string; cwd: string; createdAt: number; valid: boolean } {
	return { id, name, cwd: "/nonexistent", createdAt: Date.now(), valid: true };
}

describe("usage-service", () => {
	beforeEach(() => {
		resetUsageServiceForTesting();
	});

	it("returns empty usage and current year when no projects have sessions", async () => {
		const result = await getUsage([]);

		expect(result.usage).toEqual({});
		expect(result.years).toContain(new Date().getFullYear());
	});

	it("counts completed assistant messages from session JSONL files", async () => {
		const project = makeProject("p1", "Test Project");
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.id);
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

	it("backfills per-model cost and ignores aborted assistant messages", async () => {
		const project = makeProject("p1", "Cost Project");
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.id);
		const date = "2026-05-20";
		const ts = new Date(`${date}T12:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session-cost.jsonl"), [
			{ type: "session", version: 3, id: "session-cost", timestamp: new Date(ts).toISOString(), cwd: project.cwd },
			{
				id: "assistant-a",
				type: "message",
				message: {
					role: "assistant",
					content: "hello",
					timestamp: ts + 1000,
					model: "model-a",
					stopReason: "stop",
					usage: { cost: { total: 0.12 } },
				},
			},
			{
				id: "assistant-b",
				type: "message",
				message: {
					role: "assistant",
					content: "working",
					timestamp: ts + 2000,
					model: "model-b",
					stopReason: "toolUse",
					usage: { cost: { total: 0.03 } },
				},
			},
			{
				id: "assistant-aborted",
				type: "message",
				message: {
					role: "assistant",
					content: "...",
					timestamp: ts + 3000,
					model: "model-a",
					stopReason: "aborted",
					usage: { cost: { total: 1 } },
				},
			},
		]);

		const result = await getUsage([project]);

		expect(result.usage[date]).toBe(2);
		expect(result.modelCost[date]).toEqual({
			"model-a": { turns: 1, cost: 0.12 },
			"model-b": { turns: 1, cost: 0.03 },
		});
	});

	it("caches scan results until markUsageDirty invalidates them", async () => {
		const project = makeProject("cache-project", "Cache Project");
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.id);
		const date = "2026-06-01";
		const ts = new Date(`${date}T12:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session-cache.jsonl"), [
			{ type: "session", version: 3, id: "session-cache", timestamp: new Date(ts).toISOString(), cwd: project.cwd },
			{
				id: "assistant-a",
				type: "message",
				message: { role: "assistant", content: "hello", timestamp: ts + 1000, stopReason: "stop" },
			},
		]);

		// First call scans files and caches.
		const first = await getUsage([project]);
		expect(first.usage[date]).toBe(1);

		// New data on disk stays invisible while the cache is valid.
		writeJsonl(path.join(sessionsDir, "session-cache-2.jsonl"), [
			{
				id: "assistant-b",
				type: "message",
				message: { role: "assistant", content: "more", timestamp: ts + 2000, stopReason: "stop" },
			},
		]);
		const second = await getUsage([project]);
		expect(second.usage[date]).toBe(1);

		// markUsageDirty forces a rescan that picks up the new record.
		markUsageDirty();
		const third = await getUsage([project]);
		expect(third.usage[date]).toBe(2);
	});

	it("discards stale scan results when usage is marked dirty mid-scan", async () => {
		const project = makeProject("race-project", "Race Project");
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.id);
		const date = "2026-07-01";
		const ts = new Date(`${date}T12:00:00`).getTime();

		writeJsonl(path.join(sessionsDir, "session-race.jsonl"), [
			{
				id: "assistant-a",
				type: "message",
				message: { role: "assistant", content: "hello", timestamp: ts + 1000, stopReason: "stop" },
			},
		]);

		// Start a scan plus a caller that joins the in-flight scan, then dirty +
		// append a record before the scan can finish.
		const readdirSpy = vi.spyOn(fs.promises, "readdir");
		const inFlight = getUsage([project]);
		const joining = getUsage([project]);
		markUsageDirty();
		writeJsonl(path.join(sessionsDir, "session-race-2.jsonl"), [
			{
				id: "assistant-b",
				type: "message",
				message: { role: "assistant", content: "more", timestamp: ts + 2000, stopReason: "stop" },
			},
		]);

		// Both the initiator and the joining caller must see post-dirty data.
		expect((await inFlight).usage[date]).toBe(2);
		expect((await joining).usage[date]).toBe(2);
		// Two scans (sessions + subsessions dirs each) prove the stale scan was
		// discarded and a rescan actually happened.
		expect(readdirSpy.mock.calls.length).toBe(4);
	});

	it("excludes aborted assistant messages", async () => {
		const project = makeProject("p1", "Test Project");
		const sessionsDir = lookStorage.getWorkspaceSessionsDir(project.id);
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
});
