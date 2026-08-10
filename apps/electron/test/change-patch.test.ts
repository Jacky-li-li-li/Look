// @vitest-environment node
//
// replayFileChanges — 变更文件级重放合并测试：
//  - write 新建 → 全新增
//  - write + edit（oldText 匹配）→ 重放合并，删除+新增齐全、统计精确
//  - 仅 edit（base 未知）→ 行序列合并（-old +new）；多次操作标记近似
//  - edit oldText 精确匹配失败（SDK 模糊匹配场景）→ 降级行序列合并，变更不丢失
//  - 无有效操作 → null

import { describe, expect, it } from "vitest";
import { replayFileChanges } from "../src/renderer/lib/changePatch";

const PATH = "src/file.ts";

describe("replayFileChanges", () => {
	it("write 新建文件 → 全新增，统计等于内容行数，hunk 头为 -0,0", () => {
		const result = replayFileChanges(PATH, [{ tool: "write", args: { path: PATH, content: "line1\nline2\n" } }]);
		expect(result).not.toBeNull();
		expect(result!.added).toBe(2);
		expect(result!.deleted).toBe(0);
		expect(result!.unmatched).toBe(false);
		expect(result!.patch).toContain("@@ -0,0 +1,2 @@");
		expect(result!.patch).toContain("+line1");
		expect(result!.patch).toContain("+line2");
		expect(result!.patch).not.toMatch(/^-line/);
	});

	it("write + edit（oldText 匹配）→ 重放合并：删除+新增齐全，统计精确", () => {
		const result = replayFileChanges(PATH, [
			{ tool: "write", args: { path: PATH, content: "a\nb\nc\n" } },
			{
				tool: "edit",
				args: {
					path: PATH,
					edits: [{ oldText: "b\n", newText: "B\nb2\n" }],
				},
			},
		]);
		expect(result).not.toBeNull();
		expect(result!.unmatched).toBe(false);
		// 最终内容 a/B/b2/c：删除 1 行（b），新增 2 行（B、b2）
		expect(result!.added).toBe(2);
		expect(result!.deleted).toBe(1);
		expect(result!.patch).toContain("-b");
		expect(result!.patch).toContain("+B");
		expect(result!.patch).toContain("+b2");
		// write 的原始 b 行被 edit 替换后不再作为独立新增重复出现
		expect(result!.patch.match(/^\+b$/gm)).toBeNull();
	});

	it("多个 edit 按序应用，删除/新增累加且内容正确", () => {
		const result = replayFileChanges(PATH, [
			{ tool: "write", args: { path: PATH, content: "1\n2\n3\n4\n" } },
			{ tool: "edit", args: { path: PATH, edits: [{ oldText: "2\n", newText: "two\n" }] } },
			{ tool: "edit", args: { path: PATH, edits: [{ oldText: "4\n", newText: "four\n" }] } },
		]);
		expect(result).not.toBeNull();
		expect(result!.unmatched).toBe(false);
		// 1/two/3/four：删除 2 行（2、4），新增 2 行（two、four）
		expect(result!.added).toBe(2);
		expect(result!.deleted).toBe(2);
		expect(result!.patch).toContain("-2");
		expect(result!.patch).toContain("+two");
		expect(result!.patch).toContain("-4");
		expect(result!.patch).toContain("+four");
	});

	it("仅 edit（base 未知）→ 行序列合并：所有 -old +new 行齐全", () => {
		const result = replayFileChanges(PATH, [
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "old\n", newText: "new\n" }] },
			},
		]);
		expect(result).not.toBeNull();
		expect(result!.unmatched).toBe(false);
		expect(result!.deleted).toBe(1);
		expect(result!.added).toBe(1);
		expect(result!.patch).toContain("-old");
		expect(result!.patch).toContain("+new");
	});

	it("edit oldText 精确匹配失败（SDK 模糊匹配场景）→ 降级行序列合并，变更不丢失", () => {
		const result = replayFileChanges(PATH, [
			{ tool: "write", args: { path: PATH, content: "a\nb\n" } },
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "zzz\n", newText: "new\n" }] },
			},
		]);
		// 不静默丢弃：降级后删除/新增行都可见；多 op 标记近似（统计不可靠）
		expect(result).not.toBeNull();
		expect(result!.unmatched).toBe(false);
		expect(result!.approximate).toBe(true);
		expect(result!.patch).toContain("-zzz");
		expect(result!.patch).toContain("+new");
	});

	it("仅 edit 单次操作（base 未知）→ 行合并，统计可靠（无近似）", () => {
		const result = replayFileChanges(PATH, [
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "old\n", newText: "new\n" }] },
			},
		]);
		expect(result).not.toBeNull();
		expect(result!.approximate).toBe(false);
		expect(result!.added).toBe(1);
		expect(result!.deleted).toBe(1);
	});

	it("仅 edit 多次操作 → 行合并，标记近似（统计为操作行数非净变化）", () => {
		const result = replayFileChanges(PATH, [
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "a", newText: "b" }] },
			},
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "b", newText: "c" }] },
			},
		]);
		expect(result).not.toBeNull();
		expect(result!.approximate).toBe(true);
	});

	it("无有效操作 → null", () => {
		expect(replayFileChanges(PATH, [])).toBeNull();
		expect(replayFileChanges(PATH, [{ tool: "read", args: { path: PATH } }])).toBeNull();
	});

	it("write 后 edit 覆盖同一段：以最终内容为准（不重复计数）", () => {
		const result = replayFileChanges(PATH, [
			{ tool: "write", args: { path: PATH, content: "x\n" } },
			{
				tool: "edit",
				args: { path: PATH, edits: [{ oldText: "x\n", newText: "y\n" }] },
			},
		]);
		expect(result).not.toBeNull();
		// 最终 y：新增 1（y）、删除 1（x）——write 的 x 被替换，不重复出现
		expect(result!.added).toBe(1);
		expect(result!.deleted).toBe(1);
		expect(result!.patch).toContain("-x");
		expect(result!.patch).toContain("+y");
		expect(result!.patch.match(/^\+x$/gm)).toBeNull();
	});
});
