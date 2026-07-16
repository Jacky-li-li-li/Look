import { afterEach, describe, expect, it, vi } from "vitest";
import { LarkReplyPresenter } from "../../src/main/im/lark-reply-presenter.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("LarkReplyPresenter", () => {
	it("accumulates streamed blocks by content index and renders the completed reply", () => {
		const presenter = new LarkReplyPresenter();
		const acc = presenter.createAccumulator("session-1", "question");

		presenter.applyUiEvent(acc, { type: "assistant_text_start", contentIndex: 1, timestamp: 1 });
		presenter.applyUiEvent(acc, { type: "assistant_text_delta", contentIndex: 1, delta: "second", timestamp: 2 });
		presenter.applyUiEvent(acc, { type: "assistant_text_start", contentIndex: 0, timestamp: 3 });
		presenter.applyUiEvent(acc, { type: "assistant_text_end", contentIndex: 0, text: "first", timestamp: 4 });
		presenter.applyUiEvent(acc, {
			type: "assistant_text_end",
			contentIndex: 1,
			text: "second",
			timestamp: 5,
		});

		expect(acc.text).toBe("first\n\nsecond");
		expect(acc.textBlocks.get(0)?.completed).toBe(true);
		const card = JSON.stringify(presenter.buildStreamCard(acc));
		expect(card).toContain("first");
		expect(card).toContain("second");
	});

	it("keeps tool execution state independent from reply text", () => {
		const presenter = new LarkReplyPresenter();
		const acc = presenter.createAccumulator("session-1", "run pwd");

		presenter.applyUiEvent(acc, {
			type: "tool_exec_start",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "pwd" },
			timestamp: 1,
		});
		expect(acc.status).toBe("working");
		expect(acc.toolPanels.get("tool-1")).toMatchObject({ status: "running", args: { command: "pwd" } });

		presenter.applyUiEvent(acc, {
			type: "tool_exec_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: "/tmp/project",
			isError: false,
			timestamp: 2,
		});
		expect(acc.toolPanels.get("tool-1")).toMatchObject({ status: "success", result: "/tmp/project" });
		expect(JSON.stringify(presenter.buildStreamCard(acc))).toContain("/tmp/project");
	});

	it("coalesces scheduled card updates", async () => {
		vi.useFakeTimers();
		const presenter = new LarkReplyPresenter();
		const acc = presenter.createAccumulator("session-1", "question");
		const update = vi.fn().mockResolvedValue(undefined);
		acc.controller = { update };

		presenter.scheduleUpdate(acc);
		presenter.scheduleUpdate(acc);
		await vi.advanceTimersByTimeAsync(699);
		expect(update).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(update).toHaveBeenCalledOnce();
	});

	it("cancels scheduled updates and releases reply waiters on dispose", async () => {
		vi.useFakeTimers();
		const presenter = new LarkReplyPresenter();
		const acc = presenter.createAccumulator("session-1", "question");
		const update = vi.fn().mockResolvedValue(undefined);
		acc.controller = { update };
		presenter.scheduleUpdate(acc);

		presenter.disposeAccumulator(acc, "channel closed");
		await acc.donePromise;
		await vi.runAllTimersAsync();

		expect(acc).toMatchObject({ done: true, status: "error", error: "channel closed" });
		expect(acc.controller).toBeUndefined();
		expect(update).not.toHaveBeenCalled();
	});
});
