import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import {
	type SessionHistoryHost,
	SessionHistoryService,
} from "../src/main/session/services/session-history-service.js";

function createHost(overrides: Partial<SessionHistoryHost> = {}): SessionHistoryHost {
	return {
		ensureRuntime: async () => {
			throw new Error("not configured");
		},
		createManagedRuntime: async () => {
			throw new Error("not configured");
		},
		withSessionLock: async (_sessionId, task) => task(),
		disposeRuntime: async () => {},
		getRuntime: () => undefined,
		getSessionManager: () => undefined,
		refreshProjectSessions: async () => [],
		activateForkedSession: () => {},
		markSessionDefaultName: () => {},
		emitSessionState: () => {},
		...overrides,
	};
}

describe("SessionHistoryService", () => {
	it("navigates a live session and publishes a snapshot only after a successful navigation", async () => {
		const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
		const emitSessionState = vi.fn();
		const runtime = { runtime: { session: { navigateTree } } } as unknown as ManagedRuntime;
		const service = new SessionHistoryService(createHost({ ensureRuntime: async () => runtime, emitSessionState }));

		await expect(service.navigate("session-a", "entry-a", { label: "checkpoint" })).resolves.toEqual({
			cancelled: false,
		});
		expect(navigateTree).toHaveBeenCalledWith("entry-a", { label: "checkpoint" });
		expect(emitSessionState).toHaveBeenCalledWith("session-a", "navigate");
	});

	it("loads an older page from the current branch and returns a stable cursor", async () => {
		const branch = [
			{ id: "m1", type: "message" },
			{ id: "m2", type: "message" },
			{ id: "m3", type: "message" },
			{ id: "m4", type: "message" },
		] as unknown as ReturnType<SessionManager["getBranch"]>;
		const manager = {
			getBranch: () => branch,
			getLeafId: () => "m4",
		} as unknown as SessionManager;
		const runtime = { runtime: { session: { sessionManager: manager } } } as unknown as ManagedRuntime;
		const service = new SessionHistoryService(createHost({ ensureRuntime: async () => runtime }));

		const page = await service.loadPage("session-a", "m3", "m4", 2);

		expect(page.entries.map((entry) => entry.id)).toEqual(["m1", "m2"]);
		expect(page.history).toEqual({ cursor: "m1", hasMore: false, revision: "m4" });
	});

	it("updates an entry label and preserves the current branch leaf", () => {
		const appendLabelChange = vi.fn();
		const branch = vi.fn();
		const emitSessionState = vi.fn();
		const manager = {
			getLeafId: () => "leaf-a",
			appendLabelChange,
			branch,
			resetLeaf: vi.fn(),
		} as unknown as SessionManager;
		const service = new SessionHistoryService(createHost({ getSessionManager: () => manager, emitSessionState }));

		service.setEntryLabel("session-a", "entry-a", "  useful point  ");

		expect(appendLabelChange).toHaveBeenCalledWith("entry-a", "useful point");
		expect(branch).toHaveBeenCalledWith("leaf-a");
		expect(emitSessionState).toHaveBeenCalledWith("session-a", "navigate");
	});

	it("rejects a fork before mutating a source session that is still streaming", async () => {
		const runtime = {
			runtime: { session: { isStreaming: true, isRetrying: false, isCompacting: false } },
		} as unknown as ManagedRuntime;
		const service = new SessionHistoryService(createHost({ ensureRuntime: async () => runtime }));

		await expect(service.fork("session-a", "entry-a")).rejects.toThrow("Stop the session before forking");
	});
});
