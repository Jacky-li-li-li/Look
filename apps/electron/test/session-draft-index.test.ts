// ============================================================
// SessionDraftIndex 回归测试
//
// 未落盘会话的最小草稿索引：创建即持久、重启可恢复、
// 落盘后修剪（Proma 式双事实源的最小形态）。
// ============================================================

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionDraftIndex } from "../src/main/session/services/session-draft-index.js";

function makeIndex(): { index: SessionDraftIndex; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "look-draft-index-"));
	const filePath = join(dir, "session-drafts.json");
	return { index: new SessionDraftIndex(filePath), filePath };
}

function entry(
	id: string,
	projectId = "project-1",
	name = "draft",
	createdAt = Date.now(),
): Parameters<SessionDraftIndex["add"]>[0] {
	return { id, projectId, name, createdAt, updatedAt: createdAt };
}

describe("SessionDraftIndex", () => {
	it("add/get/list 往返，新条目在前", () => {
		const { index } = makeIndex();
		index.add(entry("older", "project-1", "旧草稿", 1_000));
		index.add(entry("newer", "project-1", "新草稿", 2_000));

		expect(index.get("older")?.name).toBe("旧草稿");
		expect(index.list("project-1").map((e) => e.id)).toEqual(["newer", "older"]);
	});

	it("持久化到磁盘：新实例（模拟重启）读到同一份索引", () => {
		const { index, filePath } = makeIndex();
		index.add(entry("draft-1"));
		index.add(entry("draft-2", "project-2"));

		const restored = new SessionDraftIndex(filePath);
		expect(restored.list("project-1").map((e) => e.id)).toEqual(["draft-1"]);
		expect(restored.get("draft-2")?.projectId).toBe("project-2");
	});

	it("remove 幂等；删除后新实例不再返回", () => {
		const { index, filePath } = makeIndex();
		index.add(entry("draft-1"));
		index.remove("draft-1");
		index.remove("draft-1");

		expect(new SessionDraftIndex(filePath).get("draft-1")).toBeUndefined();
	});

	it("prunePersisted 只移除已落盘的条目并返回数量", () => {
		const { index, filePath } = makeIndex();
		index.add(entry("persisted", "project-1"));
		index.add(entry("still-draft", "project-1"));
		index.add(entry("other-project", "project-2"));

		expect(index.prunePersisted("project-1", new Set(["persisted"]))).toBe(1);
		expect(index.get("still-draft")).toBeDefined();
		expect(index.get("other-project")).toBeDefined();
		expect(index.get("persisted")).toBeUndefined();

		const restored = new SessionDraftIndex(filePath);
		expect(restored.list("project-1").map((e) => e.id)).toEqual(["still-draft"]);
	});

	it("文件损坏/形状不符时降级为空索引，不抛错", () => {
		const { index, filePath } = makeIndex();
		index.add(entry("draft-1"));
		writeFileSync(filePath, "{corrupted json", "utf8");

		expect(index.list()).toEqual([]);
		index.add(entry("draft-2"));
		expect(new SessionDraftIndex(filePath).get("draft-2")?.id).toBe("draft-2");
	});

	it("原子写：落盘内容始终是合法 JSON 且无 tmp 残留", () => {
		const { index, filePath } = makeIndex();
		index.add(entry("draft-1"));
		const raw = readFileSync(filePath, "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
	});
});
