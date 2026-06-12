import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionAskService } from "../src/main/permissions/permission-ask";

describe("PermissionAskService", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("denies and clears a pending ask when the main-process timeout elapses", async () => {
		vi.useFakeTimers();
		const events: any[] = [];
		const service = new PermissionAskService((event) => events.push(event), 1000);

		const decision = service.ask("agent-1", {
			requestId: "req-1",
			agentId: "agent-1",
			toolName: "edit",
			args: { path: "src/file.ts" },
			reason: "Editing source file",
		});

		expect(service.hasPending("agent-1")).toBe(true);
		expect(events[0]).toMatchObject({
			type: "permission:ask",
			requestId: "req-1",
			agentId: "agent-1",
		});

		await vi.advanceTimersByTimeAsync(1000);

		await expect(decision).resolves.toEqual({ action: "deny", reason: "Timed out (1s)" });
		expect(service.hasPending("agent-1")).toBe(false);
		expect(events[1]).toMatchObject({
			type: "permission:resolved",
			requestId: "req-1",
			agentId: "agent-1",
			decision: { action: "deny", reason: "Timed out (1s)" },
		});
	});

	it("clears the timeout when the renderer resolves the ask first", async () => {
		vi.useFakeTimers();
		const events: any[] = [];
		const service = new PermissionAskService((event) => events.push(event), 1000);

		const decision = service.ask("agent-1", {
			requestId: "req-2",
			agentId: "agent-1",
			toolName: "write",
			args: { path: "package.json" },
			reason: "Writing to configuration file",
		});

		service.resolve("req-2", { action: "allow" });
		await vi.advanceTimersByTimeAsync(1000);

		await expect(decision).resolves.toEqual({ action: "allow" });
		expect(service.hasPending("agent-1")).toBe(false);
		expect(events.filter((event) => event.type === "permission:resolved")).toHaveLength(1);
		expect(events[1]).toMatchObject({
			type: "permission:resolved",
			requestId: "req-2",
			decision: { action: "allow" },
		});
	});
});
