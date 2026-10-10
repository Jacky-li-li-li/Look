import { beforeEach, describe, expect, it, vi } from "vitest";
import { LarkReplyPresenter } from "../src/main/im/lark-reply-presenter.js";
import { LarkReplyRegistry } from "../src/main/im/lark-reply-registry.js";

describe("LarkReplyRegistry", () => {
	let presenter: LarkReplyPresenter;
	let registry: LarkReplyRegistry;
	const onAgentEnd = vi.fn();
	const extract = vi.fn(() => "fallback text");

	beforeEach(() => {
		presenter = new LarkReplyPresenter();
		onAgentEnd.mockClear();
		extract.mockClear();
		registry = new LarkReplyRegistry(presenter, {
			onAgentEnd,
			extractTerminalAssistantText: extract,
		});
	});

	it("ensure creates then reuses an in-flight accumulator", () => {
		const a = registry.ensure("s1", "appA", "hello");
		const b = registry.ensure("s1", "appA", "next");
		expect(a).toBe(b);
		expect(b.userText).toBe("next");
		expect(registry.runningSessionIds()).toEqual(["s1"]);
	});

	it("releaseOwnedByApp only drops that bot's sessions", () => {
		registry.ensure("s1", "appA", "a");
		registry.ensure("s2", "appB", "b");
		registry.releaseOwnedByApp("appA", "disconnect");
		expect(registry.get("s1")).toBeUndefined();
		expect(registry.get("s2")).toBeDefined();
	});

	it("finalizeStopped marks error, flushes, and releases", async () => {
		const flush = vi.spyOn(presenter, "flushUpdate").mockResolvedValue(undefined);
		const acc = registry.ensure("s1", "appA", "hi");
		expect(acc.done).toBe(false);
		const ok = await registry.finalizeStopped("s1", "user stop", "released");
		expect(ok).toBe(true);
		expect(flush).toHaveBeenCalled();
		expect(registry.get("s1")).toBeUndefined();
		expect(registry.runningSessionIds()).toEqual([]);
	});

	it("handleAgentEvent finalizes on agent_end when not streaming", () => {
		const acc = registry.ensure("s1", "appA", "hi");
		const schedule = vi.spyOn(presenter, "scheduleUpdate");
		registry.handleAgentEvent({
			type: "session:snapshot",
			sessionId: "s1",
			reason: "agent_end",
			entries: [],
			runtime: {
				isStreaming: false,
				model: { provider: "p", id: "m" },
				stats: { tokens: { input: 1, output: 2 } },
			},
		} as never);
		expect(onAgentEnd).toHaveBeenCalledWith("s1");
		expect(extract).toHaveBeenCalled();
		expect(acc.done).toBe(true);
		expect(acc.status).toBe("done");
		expect(acc.model).toBe("p/m");
		expect(schedule).toHaveBeenCalled();
	});

	it("handleAgentEvent skips finalize while runtime still streaming (retry)", () => {
		const acc = registry.ensure("s1", "appA", "hi");
		registry.handleAgentEvent({
			type: "session:snapshot",
			sessionId: "s1",
			reason: "agent_end",
			entries: [],
			runtime: { isStreaming: true },
		} as never);
		expect(acc.done).toBe(false);
		expect(registry.get("s1")).toBe(acc);
	});
});
