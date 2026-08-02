// ============================================================
// parsePartialJson — 流式工具参数部分解析单测
//
// 回归锁定：重构期间曾把 lastSafe = i 误改为 i + 1，导致拼出的
// prefix 带尾逗号、JSON.parse 永远失败（流式工具卡 args 退化 {}）。
// ============================================================

import { describe, expect, it } from "vitest";
import { safelyParsePartialJson } from "../src/renderer/components/chat/block-renderer/parsePartialJson";

describe("safelyParsePartialJson", () => {
	it("returns the object when the JSON is complete", () => {
		expect(safelyParsePartialJson('{"a": 1, "b": 2}')).toEqual({ a: 1, b: 2 });
	});

	it("drops the trailing incomplete field after a comma", () => {
		expect(safelyParsePartialJson('{"tool": "read", "path": "/Use')).toEqual({ tool: "read" });
		expect(safelyParsePartialJson('{"a": 1, "b": 2')).toEqual({ a: 1 });
		expect(safelyParsePartialJson('{"command": "ls -la", "timeout": 5, "desc')).toEqual({
			command: "ls -la",
			timeout: 5,
		});
	});

	it("returns undefined for empty or non-object input", () => {
		expect(safelyParsePartialJson("")).toBeUndefined();
		expect(safelyParsePartialJson("[1, 2")).toBeUndefined();
	});

	it("does not split on commas inside string values", () => {
		expect(safelyParsePartialJson('{"msg": "a,b", "x": 1, "y')).toEqual({ msg: "a,b", x: 1 });
	});
});
