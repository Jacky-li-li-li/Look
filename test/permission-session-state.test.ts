import { describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../src/main/session-runtime-manager";

function createPermissionRuntime() {
	const runtime = Object.create(SessionRuntimeManager.prototype) as any;
	runtime.defaultPermissionMode = "ask";
	runtime.permissionModesBySession = new Map([
		["session-a", "ask"],
		["session-b", "ask"],
	]);
	runtime.permissionAwaiting = new Map();
	runtime.sessionAllowedTools = new Map();
	runtime.eventCallbacks = [];
	return runtime;
}

function context(sessionId: string) {
	return { sessionManager: { getSessionId: () => sessionId } };
}

describe("session permission state", () => {
	it("registers a pending request before emitting it", async () => {
		const runtime = createPermissionRuntime();
		runtime.eventCallbacks.push((event: any) => {
			if (event.type === "permission:ask") {
				runtime.handlePermissionResponse({ requestId: event.event.requestId, action: "allow" });
			}
		});

		const handler = runtime.createPermissionToolCallHandler("/tmp/project");
		await expect(handler({ toolName: "write", input: { path: "file.txt" } }, context("session-a"))).resolves.toEqual(
			{},
		);
		expect(runtime.permissionAwaiting.size).toBe(0);
	});

	it("keeps always-allow tool grants scoped to the originating session", async () => {
		const runtime = createPermissionRuntime();
		const events: any[] = [];
		runtime.eventCallbacks.push((event: any) => events.push(event));
		const handler = runtime.createPermissionToolCallHandler("/tmp/project");

		const first = handler({ toolName: "write", input: { path: "file.txt" } }, context("session-a"));
		const firstAsk = events.find((event) => event.type === "permission:ask");
		expect(firstAsk.agentId).toBe("session-a");
		runtime.handlePermissionResponse({ requestId: firstAsk.event.requestId, action: "allow_always" });
		await expect(first).resolves.toEqual({});

		const eventCount = events.length;
		await expect(
			handler({ toolName: "write", input: { path: "second.txt" } }, context("session-a")),
		).resolves.toEqual({});
		expect(events).toHaveLength(eventCount);

		const second = handler({ toolName: "write", input: { path: "other.txt" } }, context("session-b"));
		const secondAsk = events.filter((event) => event.type === "permission:ask").pop();
		expect(secondAsk.agentId).toBe("session-b");
		runtime.handlePermissionResponse({ requestId: secondAsk.event.requestId, action: "deny" });
		await expect(second).resolves.toMatchObject({ block: true });
	});
});
