import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSessionDirectory, scanSessionFileSummary } from "../src/main/session-runtime-manager";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("lightweight session summary scan", () => {
	it("extracts sidebar summary fields without building allMessagesText", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "look-session-summary-"));
		cleanup.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const firstTs = Date.UTC(2026, 0, 1);
		const secondTs = Date.UTC(2026, 0, 2);
		writeJsonl(filePath, [
			{ type: "session", version: 3, id: "session-a", timestamp: new Date(firstTs).toISOString(), cwd: dir },
			{ id: "info-a", parentId: null, type: "session_info", name: "Original", timestamp: new Date(firstTs).toISOString() },
			{ id: "user-a", parentId: "info-a", type: "message", message: { role: "user", content: "first prompt", timestamp: firstTs } },
			{
				id: "assistant-a",
				parentId: "user-a",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					timestamp: secondTs,
				},
			},
			{ id: "info-b", parentId: "assistant-a", type: "session_info", name: "Renamed", timestamp: new Date(secondTs).toISOString() },
		]);

		const summary = scanSessionFileSummary(filePath);
		expect(summary).toMatchObject({
			path: filePath,
			id: "session-a",
			cwd: dir,
			name: "Renamed",
			messageCount: 2,
			firstMessage: "first prompt",
			allMessagesText: "",
		});
		expect(summary?.created.getTime()).toBe(firstTs);
		expect(summary?.modified.getTime()).toBe(secondTs);
	});

	it("ignores invalid session files", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "look-session-summary-invalid-"));
		cleanup.push(dir);
		const filePath = path.join(dir, "broken.jsonl");
		fs.writeFileSync(filePath, `${JSON.stringify({ type: "message", message: { role: "user", content: "bad" } })}\n`);
		expect(scanSessionFileSummary(filePath)).toBeNull();
	});

	it("matches session cwd and project cwd through symlinks", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "look-session-summary-symlink-"));
		cleanup.push(root);
		const realProject = path.join(root, "project-real");
		const linkedProject = path.join(root, "project-link");
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(realProject);
		fs.mkdirSync(sessionDir);
		fs.symlinkSync(realProject, linkedProject, "dir");
		writeJsonl(path.join(sessionDir, "session.jsonl"), [
			{
				type: "session",
				version: 3,
				id: "session-link",
				timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
				cwd: linkedProject,
			},
			{ id: "user-a", parentId: null, type: "message", message: { role: "user", content: "through link", timestamp: Date.UTC(2026, 0, 1) } },
		]);

		const summaries = await scanSessionDirectory(sessionDir, realProject);
		expect(summaries.map((summary) => summary.id)).toEqual(["session-link"]);
	});

	it("scans a directory asynchronously and sorts summaries by activity", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "look-session-summary-dir-"));
		cleanup.push(root);
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir);
		for (let i = 0; i < 12; i++) {
			const ts = Date.UTC(2026, 0, i + 1);
			writeJsonl(path.join(sessionDir, `session-${i}.jsonl`), [
				{ type: "session", version: 3, id: `session-${i}`, timestamp: new Date(ts).toISOString(), cwd: root },
				{ id: `user-${i}`, parentId: null, type: "message", message: { role: "user", content: `prompt ${i}`, timestamp: ts } },
			]);
		}

		const summaries = await scanSessionDirectory(sessionDir, root);
		expect(summaries).toHaveLength(12);
		expect(summaries[0].id).toBe("session-11");
		expect(summaries.at(-1)?.id).toBe("session-0");
	});
});
