import { describe, expect, it, vi } from "vitest";
import { LarkChatTaskQueue } from "../../src/main/im/lark-chat-queue.js";

describe("LarkChatTaskQueue", () => {
	it("serializes tasks for the same chat and isolates different chats", async () => {
		const order: string[] = [];
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const first = q.enqueue("bot", "c1", async () => {
			order.push("a-start");
			await gate;
			order.push("a-end");
		});
		const second = q.enqueue("bot", "c1", async () => {
			order.push("b");
		});
		const other = q.enqueue("bot", "c2", async () => {
			order.push("c");
		});
		await other;
		expect(order).toEqual(["a-start", "c"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["a-start", "c", "a-end", "b"]);
	});

	it("failed task does not block the next one", async () => {
		const onError = vi.fn();
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`, onError);
		await q.enqueue("b", "c", async () => {
			throw new Error("boom");
		});
		let ran = false;
		await q.enqueue("b", "c", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(onError).toHaveBeenCalledOnce();
	});

	it("clearForApp only aborts that bot's keys", async () => {
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`);
		const signals: AbortSignal[] = [];
		void q.enqueue("a", "1", (signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		void q.enqueue("b", "1", (signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		// Let both in-flight tasks start
		await Promise.resolve();
		await Promise.resolve();
		expect(q.pendingCount).toBe(2);
		expect(signals).toHaveLength(2);
		q.clearForApp("a");
		expect(q.pendingCount).toBe(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		q.clear();
		expect(q.pendingCount).toBe(0);
		expect(signals[1]?.aborted).toBe(true);
	});

	it("abort cancels pending and signals in-flight", async () => {
		const order: string[] = [];
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let inFlightSignal: AbortSignal | undefined;
		const first = q.enqueue("bot", "c1", async (signal) => {
			inFlightSignal = signal;
			order.push("a-start");
			await gate;
			order.push(signal.aborted ? "a-aborted" : "a-end");
		});
		const second = q.enqueue("bot", "c1", async () => {
			order.push("b-should-not-run");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["a-start"]);
		q.abort("bot", "c1");
		expect(inFlightSignal?.aborted).toBe(true);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["a-start", "a-aborted"]);
		expect(q.pendingCount).toBe(0);
	});

	it("enqueue after abort starts a fresh chain", async () => {
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`);
		void q.enqueue("bot", "c1", () => new Promise(() => {}));
		await Promise.resolve();
		q.abort("bot", "c1");
		let ran = false;
		await q.enqueue("bot", "c1", async (signal) => {
			expect(signal.aborted).toBe(false);
			ran = true;
		});
		expect(ran).toBe(true);
	});
});
