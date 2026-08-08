import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionTail } from "../../src/main/session/services/session-history-reader.js";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sessionLine(id: string): string {
	return JSON.stringify({ type: "session", id, cwd: "/tmp/project", timestamp: "2026-08-08T00:00:00.000Z" });
}

function messageLine(id: string, content: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-08T00:00:00.000Z",
		message: { role: "user", content, timestamp: Date.now() },
	});
}

async function writeFixture(lines: string[]): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "look-history-reader-"));
	cleanup.push(directory);
	const filePath = path.join(directory, "session.jsonl");
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
	return filePath;
}

describe("readSessionTail", () => {
	it("returns the newest entries in chronological order and skips the session header", async () => {
		const filePath = await writeFixture([
			sessionLine("session-a"),
			messageLine("m1", "第一条"),
			messageLine("m2", "第二条"),
			messageLine("m3", "第三条"),
		]);

		const result = await readSessionTail(filePath, 2);

		expect(result.entries.map((entry) => entry.id)).toEqual(["m2", "m3"]);
		expect(result.entries[0]?.type).toBe("message");
		expect(result.leafId).toBe("m3");
		expect(result.history).toEqual({ cursor: "m2", hasMore: true, revision: "m3" });
	});

	it("keeps the tail aligned when the bounded read starts inside a UTF-8 JSONL line", async () => {
		const lines = [sessionLine("session-a")];
		for (let i = 0; i < 320; i += 1) lines.push(messageLine(`m${i}`, `${"内容".repeat(90)}-${i}`));
		const filePath = await writeFixture(lines);

		const result = await readSessionTail(filePath, 5);

		expect(result.entries.map((entry) => entry.id)).toEqual(["m315", "m316", "m317", "m318", "m319"]);
		expect(result.history.hasMore).toBe(true);
	});

	it("handles a malformed active tail without losing earlier valid entries", async () => {
		const filePath = await writeFixture([sessionLine("session-a"), messageLine("m1", "valid"), '{"type":"message"']);

		const result = await readSessionTail(filePath, 5);

		expect(result.entries.map((entry) => entry.id)).toEqual(["m1"]);
		expect(result.leafId).toBe("m1");
	});

	it("reports no older history for a window that contains the complete branch", async () => {
		const filePath = await writeFixture([sessionLine("session-a"), messageLine("m1", "only")]);

		const result = await readSessionTail(filePath, 10);

		expect(result.history).toEqual({ cursor: "m1", hasMore: false, revision: "m1" });
	});
});
