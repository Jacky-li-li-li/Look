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

	it("clearForApp only drops that bot's pending keys", async () => {
		const q = new LarkChatTaskQueue((a, c) => `${a}::${c}`);
		void q.enqueue("a", "1", () => new Promise(() => {}));
		void q.enqueue("b", "1", () => new Promise(() => {}));
		expect(q.pendingCount).toBe(2);
		q.clearForApp("a");
		expect(q.pendingCount).toBe(1);
		q.clear();
		expect(q.pendingCount).toBe(0);
	});
});
