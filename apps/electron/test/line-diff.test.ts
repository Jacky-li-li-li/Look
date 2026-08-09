// ============================================================
// lineDiff tests — 行级文件对比（VSCode 风格完整文件 diff）
// ============================================================

import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/renderer/lib/lineDiff";

describe("lineDiff", () => {
	it("相同内容全部为 context", () => {
		const lines = lineDiff("a\nb\nc", "a\nb\nc");
		expect(lines.map((l) => l.kind)).toEqual(["context", "context", "context"]);
		expect(lines[0]?.oldLine).toBe(1);
		expect(lines[0]?.newLine).toBe(1);
	});

	it("新增行标记为 add", () => {
		const lines = lineDiff("a\nb", "a\nx\nb");
		expect(lines.map((l) => l.kind)).toEqual(["context", "add", "context"]);
		expect(lines[1]?.text).toBe("x");
		expect(lines[1]?.newLine).toBe(2);
	});

	it("删除行标记为 del", () => {
		const lines = lineDiff("a\nx\nb", "a\nb");
		expect(lines.map((l) => l.kind)).toEqual(["context", "del", "context"]);
		expect(lines[1]?.text).toBe("x");
		expect(lines[1]?.oldLine).toBe(2);
	});

	it("修改行：旧删除 + 新新增", () => {
		const lines = lineDiff("old line", "new line");
		expect(lines.map((l) => l.kind)).toEqual(["del", "add"]);
	});

	it("末尾新增", () => {
		const lines = lineDiff("a", "a\nb\nc");
		expect(lines.map((l) => l.kind)).toEqual(["context", "add", "add"]);
	});

	it("末尾删除", () => {
		const lines = lineDiff("a\nb\nc", "a");
		expect(lines.map((l) => l.kind)).toEqual(["context", "del", "del"]);
	});

	it("空文件", () => {
		expect(lineDiff("", "")).toEqual([]);
		expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x", newLine: 1 }]);
	});
});
