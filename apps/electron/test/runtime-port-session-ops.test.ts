import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: { list: (...args: unknown[]) => list(...args) },
}));

const { listEngineSessions } = await import("../src/main/runtime-port/pi-session-ops.js");

describe("listEngineSessions", () => {
	beforeEach(() => {
		list.mockReset();
	});

	it("delegates to SessionManager.list with cwd + sessionsDir", async () => {
		list.mockResolvedValue([]);
		await expect(listEngineSessions("/project", "/sessions")).resolves.toEqual([]);
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledWith("/project", "/sessions");
	});

	it("maps pi SessionInfo rows to Look PersistedSessionRow, dropping engine-only fields", async () => {
		const created = new Date("2026-10-01T00:00:00Z");
		const modified = new Date("2026-10-02T00:00:00Z");
		list.mockResolvedValue([
			{
				path: "/sessions/a.jsonl",
				id: "a",
				cwd: "/project",
				name: "Session A",
				parentSessionPath: "/sessions/root.jsonl",
				created,
				modified,
				messageCount: 3,
				firstMessage: "hello",
				allMessagesText: "hello world",
				// engine-only extras must not leak into the Look row
				engineInternal: { secret: true },
			},
			{
				path: "/sessions/b.jsonl",
				id: "b",
				cwd: "/project",
				created,
				modified,
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			},
		]);

		const rows = await listEngineSessions("/project", "/sessions");

		expect(rows).toEqual([
			{
				path: "/sessions/a.jsonl",
				id: "a",
				cwd: "/project",
				name: "Session A",
				parentSessionPath: "/sessions/root.jsonl",
				created,
				modified,
				messageCount: 3,
				firstMessage: "hello",
				allMessagesText: "hello world",
			},
			{
				path: "/sessions/b.jsonl",
				id: "b",
				cwd: "/project",
				name: undefined,
				parentSessionPath: undefined,
				created,
				modified,
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			},
		]);
		expect(rows[0]).not.toHaveProperty("engineInternal");
		// Dates are passed through (same instances), not re-parsed.
		expect(rows[0]?.created).toBe(created);
	});

	it("propagates SessionManager.list failures", async () => {
		list.mockRejectedValue(new Error("disk gone"));
		await expect(listEngineSessions("/project", "/sessions")).rejects.toThrow("disk gone");
	});
});
