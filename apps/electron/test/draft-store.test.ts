// DraftStore — CRUD + 原子持久化

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftStore } from "../src/main/drafts/draft-store.js";

describe("DraftStore", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "draft-store-test-"));
		filePath = path.join(dir, "drafts.json");
	});

	afterEach(() => {
		writeFileSync(filePath, "{}"); // 无操作，仅确保测试目录可复用
	});

	it("creates drafts and lists them newest first", async () => {
		const store = new DraftStore(filePath);
		const first = await store.create("idea one");
		await store.create("idea two");

		const drafts = store.list();
		expect(drafts).toHaveLength(2);
		expect(drafts[0].text).toBe("idea two");
		expect(drafts[1].id).toBe(first.id);
		expect(first.id).toBeTruthy();
		expect(first.createdAt).toBeGreaterThan(0);
	});

	it("trims text and rejects empty or oversized drafts", async () => {
		const store = new DraftStore(filePath);
		const draft = await store.create("  padded  ");
		expect(draft.text).toBe("padded");

		await expect(store.create("   ")).rejects.toThrow(/empty/i);
		await expect(store.create("x".repeat(4_001))).rejects.toThrow(/exceeds/i);
	});

	it("updates an existing draft and throws for unknown ids", async () => {
		const store = new DraftStore(filePath);
		const draft = await store.create("before");
		const updated = await store.update(draft.id, { text: "after" });
		expect(updated.text).toBe("after");
		expect(store.list()[0].text).toBe("after");
		await expect(store.update("missing-id", { text: "x" })).rejects.toThrow(/not found/i);
	});

	it("marks a draft as converted with its session id", async () => {
		const store = new DraftStore(filePath);
		const draft = await store.create("convert me");
		const marked = await store.update(draft.id, { convertedSessionId: "session-abc" });
		expect(marked.convertedSessionId).toBe("session-abc");
		expect(store.list()[0].convertedSessionId).toBe("session-abc");
		// 可清除转化标记
		const cleared = await store.update(draft.id, { convertedSessionId: null });
		expect(cleared.convertedSessionId).toBeUndefined();
	});

	it("deletes drafts and throws for unknown ids", async () => {
		const store = new DraftStore(filePath);
		const draft = await store.create("to delete");
		await store.delete(draft.id);
		expect(store.list()).toHaveLength(0);
		await expect(store.delete(draft.id)).rejects.toThrow(/not found/i);
	});

	it("persists across instances (atomic JSON file)", async () => {
		const store = new DraftStore(filePath);
		await store.create("persisted draft");
		await store.flush();

		const reloaded = new DraftStore(filePath);
		const drafts = reloaded.list();
		expect(drafts).toHaveLength(1);
		expect(drafts[0].text).toBe("persisted draft");

		// 文件已落盘且不是 tmp 残留
		const raw = readFileSync(filePath, "utf8");
		expect(raw).toContain("persisted draft");
		expect(raw).not.toContain(".tmp");
	});

	it("falls back to an empty database for corrupt files", async () => {
		writeFileSync(filePath, "{ not valid json");
		const store = new DraftStore(filePath);
		expect(store.list()).toEqual([]);
		// 损坏文件恢复后可继续写入
		await store.create("recovered");
		await store.flush();
		expect(store.list()).toHaveLength(1);
	});
});
