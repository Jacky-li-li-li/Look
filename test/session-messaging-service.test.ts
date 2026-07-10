// ============================================================
// SessionMessagingService unit tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionMessagingService } from "../src/main/session/session-messaging-service.js";
import type { ManagedRuntime } from "../src/main/session/runtime-registry.js";

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
		expect(prompt).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ source: "rpc" }),
		);
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
});
