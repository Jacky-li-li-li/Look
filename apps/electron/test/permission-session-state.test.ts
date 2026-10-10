import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { IEventBus } from "../src/main/core/contracts";
import { PermissionService } from "../src/main/permissions/service.js";

function mockEventBus(events: unknown[]): IEventBus {
	return {
		emit(event) {
			events.push(event);
		},
		onEvent() {
			return () => {};
		},
	};
}

function context(sessionId: string) {
	return { sessionManager: { getSessionId: () => sessionId } };
}

describe("session permission state", () => {
	it("persists dirty state to the explicitly supplied session manager", () => {
		const appendPrevious = vi.fn();
		const previousManager = {
			isPersisted: () => true,
			appendCustomEntry: appendPrevious,
		} as unknown as SessionManager;
		const svc = new PermissionService(mockEventBus([]), "ask");

		svc.setMode("session-a", "always");
		svc.persistIfDirty("session-a", previousManager);

		expect(appendPrevious).toHaveBeenCalledTimes(1);
	});

	it("registers a pending request before emitting it", async () => {
		const events: unknown[] = [];
		const svc = new PermissionService(mockEventBus(events), "ask");
		const handler = svc.createToolCallHandler("/tmp/project");
		const promise = handler({ toolName: "write", input: { path: "file.txt" } }, context("session-a"));
		// Respond after the permission:ask event has been emitted
		const askEvent = events.find((e) => (e as Record<string, unknown>)?.type === "permission:ask") as Record<
			string,
			{ requestId: string }
		>;
		svc.handleResponse({ requestId: askEvent.event.requestId, action: "allow" });
		await expect(promise).resolves.toEqual({});
	});

	it("keeps always-allow tool grants scoped to the originating session", async () => {
		const events: unknown[] = [];
		const svc = new PermissionService(mockEventBus(events), "ask");
		const handler = svc.createToolCallHandler("/tmp/project");

		// Session A: first call triggers permission ask
		const first = handler({ toolName: "write", input: { path: "file.txt" } }, context("session-a"));
		const firstAsk = events.find((ev) => (ev as Record<string, unknown>)?.type === "permission:ask") as Record<
			string,
			{ requestId: string; agentId: string }
		>;
		expect(firstAsk.agentId).toBe("session-a");
		svc.handleResponse({ requestId: firstAsk.event.requestId, action: "allow_always" });
		await expect(first).resolves.toEqual({});

		// Session A: second call should be auto-allowed (no new emit)
		const eventCount = events.length;
		await expect(
			handler({ toolName: "write", input: { path: "second.txt" } }, context("session-a")),
		).resolves.toEqual({});
		expect(events).toHaveLength(eventCount);

		// Session B: first call triggers a fresh permission ask
		const second = handler({ toolName: "write", input: { path: "other.txt" } }, context("session-b"));
		const secondAsk = events
			.filter((ev) => (ev as Record<string, unknown>)?.type === "permission:ask")
			.pop() as Record<string, { requestId: string; agentId: string }>;
		expect(secondAsk.agentId).toBe("session-b");
		svc.handleResponse({ requestId: secondAsk.event.requestId, action: "deny" });
		await expect(second).resolves.toMatchObject({ block: true });
	});

	it("scopes bash always-allow grants to argv0 and never caches metachar/wrapper commands", async () => {
		const events: unknown[] = [];
		const svc = new PermissionService(mockEventBus(events), "ask");
		const handler = svc.createToolCallHandler("/tmp/project");
		const lastAsk = () =>
			events.filter((e) => (e as Record<string, unknown>)?.type === "permission:ask").pop() as Record<
				string,
				{ requestId: string; alwaysAllowScope: string | null }
			>;

		const first = handler({ toolName: "bash", input: { command: "git status" } }, context("s"));
		expect(lastAsk().event.alwaysAllowScope).toBe("bash:git");
		svc.handleResponse({ requestId: lastAsk().event.requestId, action: "allow_always" });
		await expect(first).resolves.toEqual({});

		// same program → auto allowed
		const count = events.length;
		await expect(handler({ toolName: "bash", input: { command: "git log -1" } }, context("s"))).resolves.toEqual({});
		expect(events).toHaveLength(count);

		// different program → asks again
		const rm = handler({ toolName: "bash", input: { command: "rm -rf build" } }, context("s"));
		expect(lastAsk().event.alwaysAllowScope).toBe("bash:rm");
		svc.handleResponse({ requestId: lastAsk().event.requestId, action: "deny" });
		await expect(rm).resolves.toMatchObject({ block: true });

		// chained command starting with git → not cacheable, asks, allow_always only allows once
		const chained = handler({ toolName: "bash", input: { command: "git status && rm -rf /" } }, context("s"));
		expect(lastAsk().event.alwaysAllowScope).toBeNull();
		svc.handleResponse({ requestId: lastAsk().event.requestId, action: "allow_always" });
		await expect(chained).resolves.toEqual({});
		const again = handler({ toolName: "bash", input: { command: "git status && rm -rf /" } }, context("s"));
		expect(lastAsk().event.alwaysAllowScope).toBeNull();
		svc.handleResponse({ requestId: lastAsk().event.requestId, action: "deny" });
		await expect(again).resolves.toMatchObject({ block: true });

		// wrapper programs are never cacheable
		const sudo = handler({ toolName: "bash", input: { command: "sudo ls" } }, context("s"));
		expect(lastAsk().event.alwaysAllowScope).toBeNull();
		svc.handleResponse({ requestId: lastAsk().event.requestId, action: "deny" });
		await sudo;
	});
});
