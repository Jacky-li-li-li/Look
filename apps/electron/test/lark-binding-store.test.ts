import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/im/im-storage.js", () => ({
	loadBindings: vi.fn(() => []),
	saveBindings: vi.fn(),
}));

import type { ChatBinding } from "../src/main/im/im-storage.js";
import { saveBindings } from "../src/main/im/im-storage.js";
import { LarkBindingStore } from "../src/main/im/lark-binding-store.js";

function binding(partial: Partial<ChatBinding> & Pick<ChatBinding, "chatId" | "sessionId">): ChatBinding {
	return {
		projectId: "p1",
		createdAt: 1,
		...partial,
	} as ChatBinding;
}

describe("LarkBindingStore", () => {
	beforeEach(() => {
		vi.mocked(saveBindings).mockClear();
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("keys by appId::chatId and claims legacy bare chatId bindings", () => {
		const removed: string[] = [];
		const store = new LarkBindingStore((sessionId) => removed.push(sessionId));
		const legacy = binding({ chatId: "c1", sessionId: "s1" });
		store.set("c1", legacy);

		const found = store.findBinding("appA", "c1");
		expect(found).toBe(legacy);
		expect(found?.appId).toBe("appA");
		expect(store.get("c1")).toBeUndefined();
		expect(store.get("appA::c1")).toBe(legacy);
		expect(saveBindings).toHaveBeenCalled();
	});

	it("validates bindings and removes stale records", () => {
		const removed: Array<{ id: string; reason: string }> = [];
		const store = new LarkBindingStore((sessionId, reason) => removed.push({ id: sessionId, reason }));
		const b = binding({ chatId: "c1", sessionId: "gone", appId: "a1" });
		store.set(store.keyFor("a1", "c1"), b);
		expect(store.validateBinding(b, () => null)).toBe(false);
		expect(removed).toEqual([{ id: "gone", reason: "飞书会话绑定已失效" }]);
		expect(store.size).toBe(0);
	});

	it("heals projectId drift without removing the binding", () => {
		const store = new LarkBindingStore();
		const b = binding({ chatId: "c1", sessionId: "s1", appId: "a1", projectId: "old" });
		store.set(store.keyFor("a1", "c1"), b);
		expect(store.validateBinding(b, () => ({ projectId: "new", sessionFilePath: "/tmp/x" }))).toBe(true);
		expect(b.projectId).toBe("new");
		expect(store.size).toBe(1);
	});
});
