import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLegacySessionsOnce } from "@shared/look-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SDK-native message reset", () => {
	it("deletes legacy sessions once, clears UI session references, and preserves other settings", async () => {
		const lookDir = await mkdtemp(join(tmpdir(), "look-sdk-reset-"));
		cleanup.push(lookDir);
		const sessionsDir = join(lookDir, "sessions");
		fs.mkdirSync(sessionsDir);
		fs.writeFileSync(join(sessionsDir, "legacy.jsonl"), "legacy");
		for (const file of ["projects.json", "auth.json", "models.json", "mcp-servers.json"]) {
			fs.writeFileSync(join(lookDir, file), file);
		}
		fs.writeFileSync(
			join(lookDir, "ui-settings.json"),
			JSON.stringify({
				language: "zh",
				lastActiveSessionId: "old",
				openedSessionIds: ["old"],
				lastActiveAgentId: "old",
			}),
		);

		resetLegacySessionsOnce(lookDir);

		expect(fs.readdirSync(sessionsDir)).toEqual([]);
		expect(fs.existsSync(join(lookDir, ".sdk-message-reset-v1"))).toBe(true);
		const settings = JSON.parse(fs.readFileSync(join(lookDir, "ui-settings.json"), "utf8"));
		expect(settings).toMatchObject({ language: "zh", lastActiveSessionId: "", openedSessionIds: [] });
		expect(settings).not.toHaveProperty("lastActiveAgentId");
		for (const file of ["projects.json", "auth.json", "models.json", "mcp-servers.json"]) {
			expect(fs.readFileSync(join(lookDir, file), "utf8")).toBe(file);
		}

		fs.writeFileSync(join(sessionsDir, "native.jsonl"), "native");
		resetLegacySessionsOnce(lookDir);
		expect(fs.readFileSync(join(sessionsDir, "native.jsonl"), "utf8")).toBe("native");
	});

	it("does not create the marker when the reset cannot complete", async () => {
		const lookDir = await mkdtemp(join(tmpdir(), "look-sdk-reset-failure-"));
		cleanup.push(lookDir);
		fs.mkdirSync(join(lookDir, "sessions"));
		fs.writeFileSync(join(lookDir, "sessions", "legacy.jsonl"), "legacy");
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("disk failure");
		});

		expect(() => resetLegacySessionsOnce(lookDir)).toThrow("disk failure");
		expect(fs.existsSync(join(lookDir, ".sdk-message-reset-v1"))).toBe(false);
	});
});
