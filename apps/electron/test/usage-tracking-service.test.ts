import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ incrementTurn: vi.fn(), formatLocalDate: vi.fn(() => "2026-07-16") }));

vi.mock("../src/main/system/usage.js", () => usage);

import { UsageTrackingService } from "../src/main/session/usage-tracking-service.js";

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("UsageTrackingService", () => {
	it("records completed turns and debounces renderer refreshes", () => {
		vi.useFakeTimers();
		const emit = vi.fn();
		const service = new UsageTrackingService(emit);
		const message = {
			role: "assistant",
			stopReason: "stop",
			model: "model-1",
			usage: { cost: { total: 0.25 } },
		} as unknown as AgentMessage;

		service.recordMessageEnd(message);
		service.recordMessageEnd(message);
		expect(usage.incrementTurn).toHaveBeenCalledTimes(2);
		expect(emit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(300);
		expect(emit).toHaveBeenCalledOnce();
		expect(emit).toHaveBeenCalledWith({ type: "usage:updated" });
	});

	it("ignores aborted turns and cancels pending refreshes on dispose", () => {
		vi.useFakeTimers();
		const emit = vi.fn();
		const service = new UsageTrackingService(emit);
		service.recordMessageEnd({ role: "assistant", stopReason: "aborted" } as unknown as AgentMessage);
		expect(usage.incrementTurn).not.toHaveBeenCalled();

		service.recordMessageEnd({ role: "assistant", stopReason: "stop" } as unknown as AgentMessage);
		service.dispose();
		vi.runAllTimers();
		expect(emit).not.toHaveBeenCalled();
	});
});
