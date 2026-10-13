import { describe, expect, it, vi } from "vitest";
import { createPiSessionView, type PiSessionViewRuntime } from "../src/main/runtime-port/pi-session-view.js";

describe("PiSessionView", () => {
	it("delegates to the runtime's current session (survives in-place session replacement)", async () => {
		const first = { sessionId: "a", setModel: vi.fn(async () => undefined) };
		const second = { sessionId: "b", setModel: vi.fn(async () => undefined) };
		const runtime = { session: first } as unknown as PiSessionViewRuntime & { session: unknown };
		const view = createPiSessionView(runtime);
		expect(view.sessionId).toBe("a");
		(runtime as { session: unknown }).session = second;
		expect(view.sessionId).toBe("b");

		const model = { provider: "openai", id: "gpt" };
		await view.setModel(model);
		// Same object reaches pi (narrowing only, no re-resolution / copy).
		expect(second.setModel).toHaveBeenCalledWith(model);
		expect(first.setModel).not.toHaveBeenCalled();
	});

	it("runBeforeForkHooks reports cancellation only when an extension cancels", async () => {
		const emit = vi.fn(async () => ({ cancel: true }));
		const hasHandlers = vi.fn(() => true);
		const view = createPiSessionView({
			session: { extensionRunner: { hasHandlers, emit } },
		} as unknown as PiSessionViewRuntime);
		await expect(view.runBeforeForkHooks("e1")).resolves.toBe(true);
		expect(emit).toHaveBeenCalledWith({ type: "session_before_fork", entryId: "e1", position: "at" });

		hasHandlers.mockReturnValue(false);
		emit.mockClear();
		await expect(view.runBeforeForkHooks("e1")).resolves.toBe(false);
		expect(emit).not.toHaveBeenCalled();
	});
});
