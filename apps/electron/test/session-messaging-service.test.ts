// ============================================================
// SessionMessagingService unit tests
// ============================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import {
	type SendMessageResult,
	type SessionMessagingHost,
	SessionMessagingService,
} from "../src/main/session/services/session-messaging-service.js";

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

function createHost(overrides: Partial<SessionMessagingHost> = {}): SessionMessagingHost {
	return {
		getManagedRuntime: () => undefined,
		ensureRuntime: () => Promise.reject(new Error("not configured")),
		sessionExists: () => false,
		ensureMcpReady: () => Promise.resolve(),
		emitError: () => {},
		attachments: { buildPrompt: (text: string) => text } as unknown as SessionMessagingHost["attachments"],
		...overrides,
	};
}

function liveHost(session: AgentSession, overrides: Partial<SessionMessagingHost> = {}) {
	const managed = makeManagedRuntime(session);
	return {
		managed,
		host: createHost({ getManagedRuntime: () => managed, ...overrides }),
	};
}

describe("SessionMessagingService", () => {
	it("sends a plain prompt", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;
		const { host } = liveHost(session);
		const service = new SessionMessagingService(host);

		const result = await service.sendMessage("s1", "hello");
		expect(result).toEqual<SendMessageResult>({ queued: false });
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
		const { host } = liveHost(session);
		const service = new SessionMessagingService(host);

		await service.sendMessage("s1", "hello", undefined, undefined, "steer");
		expect(prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ streamingBehavior: "steer" }));
	});

	it("defaults the streaming behavior to followUp when sendMode is omitted", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;
		const { host } = liveHost(session);
		const service = new SessionMessagingService(host);

		await service.sendMessage("s1", "hello");
		expect(prompt).toHaveBeenCalledWith("hello", expect.objectContaining({ streamingBehavior: "followUp" }));
	});

	it("prepends a subagent hint when /agent:name is present", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;
		const { host } = liveHost(session);
		const service = new SessionMessagingService(host);

		await service.sendMessage("s1", "/agent:test do thing");
		expect(prompt).toHaveBeenCalled();
		const calledText = prompt.mock.calls[0][0] as string;
		expect(calledText).toContain("[Use subagent");
		expect(calledText).toContain("/agent:test do thing");
	});

	it("rejects for a session that does not exist without emitting a duplicate error event", async () => {
		const emitError = vi.fn();
		const service = new SessionMessagingService(createHost({ sessionExists: () => false, emitError }));

		await expect(service.sendMessage("s1", "hello")).rejects.toThrow("Session s1 not found");
		expect(emitError).not.toHaveBeenCalled();
	});

	it("queues the message and kicks off runtime creation when the runtime is not ready", async () => {
		const ensureRuntime = vi.fn(() => new Promise<ManagedRuntime>(() => {}));
		const service = new SessionMessagingService(createHost({ sessionExists: () => true, ensureRuntime }));

		const result = await service.sendMessage("s1", "hello");

		expect(result).toEqual<SendMessageResult>({ queued: true });
		expect(ensureRuntime).toHaveBeenCalledWith("s1");
	});

	it("flushes queued messages in order once the runtime binds", async () => {
		const prompt = mockPrompt();
		const session = { sessionId: "s1", prompt, isStreaming: false } as unknown as AgentSession;
		// 先无 runtime（挂起两条），bind 后 getManagedRuntime 返回 live runtime。
		let managed: ManagedRuntime | undefined;
		const host = createHost({
			sessionExists: () => true,
			ensureRuntime: () => new Promise<ManagedRuntime>(() => {}),
			getManagedRuntime: () => managed,
		});
		const service = new SessionMessagingService(host);
		await service.sendMessage("s1", "first");
		await service.sendMessage("s1", "second", undefined, undefined, "steer");

		managed = makeManagedRuntime(session);
		await service.flushPending(managed);

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(prompt.mock.calls[0][0]).toBe("first");
		expect(prompt.mock.calls[1][0]).toBe("second");
		expect(prompt.mock.calls[1][1]).toEqual(expect.objectContaining({ streamingBehavior: "steer" }));
		// 队列已排空：后续发送走直发路径。
		const result = await service.sendMessage("s1", "third");
		expect(result).toEqual<SendMessageResult>({ queued: false });
		expect(prompt).toHaveBeenCalledTimes(3);
	});

	it("disposeSession drops queued messages", async () => {
		const prompt = mockPrompt();
		const session = { prompt, isStreaming: false } as unknown as AgentSession;
		const host = createHost({
			sessionExists: () => true,
			ensureRuntime: () => new Promise<ManagedRuntime>(() => {}),
		});
		const service = new SessionMessagingService(host);
		await service.sendMessage("s1", "hello");

		service.disposeSession("s1");
		await service.flushPending(makeManagedRuntime(session));

		expect(prompt).not.toHaveBeenCalled();
	});
});
