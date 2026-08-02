// ============================================================
// resolveDevLookHome — dev/正式环境业务数据目录隔离
//
// 回归：dev（未打包）应使用独立的 ~/.look-dev，避免污染正式版 ~/.look；
// 正式版与外部显式设置的 LOOK_HOME 应原样保持。
// ============================================================

import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevLookHome } from "../src/main/system/dev-look-home.js";

describe("resolveDevLookHome", () => {
	const homedir = "/Users/test";

	it("returns undefined for packaged builds (keep default ~/.look)", () => {
		expect(resolveDevLookHome(true, undefined, homedir)).toBeUndefined();
	});

	it("returns ~/.look-dev for dev builds without an external override", () => {
		expect(resolveDevLookHome(false, undefined, homedir)).toBe(path.join(homedir, ".look-dev"));
	});

	it("keeps an externally provided LOOK_HOME untouched", () => {
		expect(resolveDevLookHome(false, "/tmp/custom-look-home", homedir)).toBe("/tmp/custom-look-home");
		expect(resolveDevLookHome(true, "/tmp/custom-look-home", homedir)).toBe("/tmp/custom-look-home");
	});
});
