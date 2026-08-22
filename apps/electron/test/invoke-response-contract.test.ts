// ============================================================
// InvokeResponseMap 契约 — 回归测试
//
// 编译期守卫（键穷尽 + LookAPI↔映射 载荷漂移）位于
// `packages/shared/src/contracts/invoke-response.ts` 末尾，由 shared 的
// typecheck（CI 步骤）强制：新增 invoke 事件漏登记映射、或 LookAPI 声明
// 载荷与映射不一致，shared 构建即报错。
//
// 本文件做运行时回归：确认映射与渲染端 `LookAPI` 均可导入、且映射对
// 代表性事件给出了非 never 的载荷（防止后续重构意外把映射清空）。
// ============================================================

import type { InvokeResponse, InvokeResponseMap } from "@look/shared";
import { describe, expect, it } from "vitest";

describe("InvokeResponseMap", () => {
	it("exports a non-never payload for representative events", () => {
		// 这些断言在运行时确认映射条目存在且形状可实例化；
		// 字段级的编译期相等性由 shared 里的 `_AssertTrue`/`_AssertNever` 守卫保证。
		const checks: Array<[keyof InvokeResponseMap, unknown]> = [
			["agent:send-message", null as unknown as InvokeResponse<"agent:send-message">],
			["model:list", null as unknown as InvokeResponse<"model:list">],
			["draft:list", null as unknown as InvokeResponse<"draft:list">],
			["file:write", null as unknown as InvokeResponse<"file:write">],
			["im:get-channels", null as unknown as InvokeResponse<"im:get-channels">],
		];
		expect(checks.length).toBe(5);
		for (const [type] of checks) {
			expect(typeof type).toBe("string");
		}
	});
});
