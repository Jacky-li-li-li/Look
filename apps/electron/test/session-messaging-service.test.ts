// ============================================================
// SessionMessagingService unit tests
// ============================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import { SessionMessagingService } from "../src/main/session/services/session-messaging-service.js";

vi.mock("../src/main/extensions/subagent/agent-discovery.js", () => ({
	discoverAgents: vi.fn(() => Promise.resolve({ agents: [{ name: "test", description: "", systemPrompt: "" }] })),
}));

function makeManagedRuntime(session: AgentSession): ManagedRuntime {
	return {
		runtime: { session },
		projectId: "p1",
		createdAt: 1,
		unsubscribe: () => {},
	} as unknown as ManagedRuntime;
}

function mockPrompt() {
	return vi.fn(async (_text: string, opts: { preflightResult?: (success: boolean) => void }) => {
		opts.preflightResult?.(true);
	});
}

describe("SessionMessagingService", () => {
	it("sends a plain prompt", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;

		const service = new SessionMessagingService({
			ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(session))),
			emitError: vi.fn(),
		});

		await service.sendMessage("s1", "hello");
		expect(prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ source: "rpc" }));
	});

	// Regression: the queue decision must be left entirely to the SDK's prompt()
	// internal isStreaming check. Reading session.isStreaming here too creates a
	// TOCTOU where the session becomes streaming between the two reads and the SDK
	// throws "Agent is already processing" (message lost). The sendMode-derived
	// behavior is passed unconditionally — it is ignored on the direct (idle) path
	// and only used to queue when the SDK is actually busy.
	it("passes streamingBehavior unconditionally (ignored by the SDK when idle)", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;

		const service = new SessionMessagingService({
			ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(session))),
			emitError: vi.fn(),
		});

		await service.sendMessage("s1", "hello", undefined, "steer");
		expect(prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ streamingBehavior: "steer" }));
	});

	it("defaults the streaming behavior to followUp when sendMode is omitted", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;

		const service = new SessionMessagingService({
			ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(session))),
			emitError: vi.fn(),
		});

		await service.sendMessage("s1", "hello");
		expect(prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ streamingBehavior: "followUp" }));
	});

	it("prepends a subagent hint when /agent:name is present", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;

		const service = new SessionMessagingService({
			ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(session))),
			emitError: vi.fn(),
		});

		await service.sendMessage("s1", "/agent:test do thing");
		expect(prompt).toHaveBeenCalled();
		const calledText = prompt.mock.calls[0][0] as string;
		expect(calledText).toContain("[Use subagent");
		expect(calledText).toContain("/agent:test do thing");
	});

	it("leaves preflight failures to the IPC caller without emitting a duplicate error event", async () => {
		const emitError = vi.fn();
		const service = new SessionMessagingService({
			ensureRuntime: vi.fn(() => Promise.reject(new Error("runtime unavailable"))),
			emitError,
		});

		await expect(service.sendMessage("s1", "hello")).rejects.toThrow("runtime unavailable");
		expect(emitError).not.toHaveBeenCalled();
	});
});
