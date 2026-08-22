// ============================================================
// fileViewerUtils 纯函数单测
//
// 路径展示与边界判断是 FileViewerDialog 的高频路径，拆分后可独立验证。
// ============================================================

import { describe, expect, it } from "vitest";
import {
	formatBytes,
	isPathInsideProject,
	normalizeComparablePath,
	shortenPath,
	truncateMiddle,
} from "../../src/renderer/components/dialogs/file-viewer/fileViewerUtils";

// node 测试环境无 window，shortenPath 的 HOME_DIR 守卫为空串 → 原样返回。

describe("shortenPath", () => {
	it("node 环境无 HOME_DIR，原样返回", () => {
		// 测试环境（node）无 window.look，HOME_DIR 为空串 → 不做替换。
		expect(shortenPath("/Users/test/projects/look")).toBe("/Users/test/projects/look");
		expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
	});

	it("空字符串原样返回", () => {
		expect(shortenPath("")).toBe("");
	});
});

describe("truncateMiddle", () => {
	it("短于阈值原样返回", () => {
		expect(truncateMiddle("short", 72)).toBe("short");
	});

	it("长路径中间省略，保留首尾", () => {
		const long = "/very/long/path/to/some/file/that/exceeds/the/max/limit.tsx";
		const out = truncateMiddle(long, 30);
		expect(out.length).toBeLessThanOrEqual(30);
		expect(out).toContain("…");
		expect(out.startsWith("/")).toBe(true);
		expect(out.endsWith(".tsx")).toBe(true);
	});

	it("默认阈值 72", () => {
		const long = "x".repeat(100);
		expect(truncateMiddle(long).length).toBeLessThanOrEqual(72);
	});
});

describe("normalizeComparablePath", () => {
	it("反斜杠统一为正斜杠", () => {
		expect(normalizeComparablePath("a\\b\\c")).toBe("a/b/c");
	});

	it("去尾斜杠", () => {
		expect(normalizeComparablePath("a/b/c/")).toBe("a/b/c");
	});

	it("根斜杠保留", () => {
		expect(normalizeComparablePath("/")).toBe("/");
	});

	it("Windows 盘符小写", () => {
		expect(normalizeComparablePath("C:/Users/Test")).toBe("c:/users/test");
	});

	it("非 Windows 绝对路径不大写化", () => {
		expect(normalizeComparablePath("/Users/Test")).toBe("/Users/Test");
	});
});

describe("isPathInsideProject", () => {
	it("项目内文件为真", () => {
		expect(isPathInsideProject("/proj/src/index.ts", "/proj")).toBe(true);
	});

	it("恰好项目根为真", () => {
		expect(isPathInsideProject("/proj", "/proj")).toBe(true);
	});

	it("项目外文件为假", () => {
		expect(isPathInsideProject("/etc/hosts", "/proj")).toBe(false);
	});

	it("兄弟目录前缀为假（非子路径）", () => {
		// /project-foo 不是 /project 的子路径
		expect(isPathInsideProject("/project-foo/x", "/project")).toBe(false);
	});

	it("大小写不敏感（非 Windows 路径仅斜杠归一，不大写化）", () => {
		// normalizeComparablePath 对非 Windows 路径不做大小写转换；
		// isPathInsideProject 用比较判断，大小写需完全一致。
		expect(isPathInsideProject("/Proj/Src", "/Proj")).toBe(true);
		expect(isPathInsideProject("/proj/src", "/proj")).toBe(true);
	});

	it("斜杠风格混合", () => {
		expect(isPathInsideProject("C:\\proj\\src", "c:/proj")).toBe(true);
	});

	it("空项目根为假", () => {
		expect(isPathInsideProject("/proj/x", "")).toBe(false);
	});
});

describe("formatBytes", () => {
	it("字节级用 B", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("KB 级保留 1 位小数", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 12.4)).toBe("12.4 KB");
	});

	it("≥100 KB 取整", () => {
		expect(formatBytes(1024 * 150)).toBe("150 KB");
	});

	it("MB 级", () => {
		expect(formatBytes(1024 * 1024 * 1.2)).toBe("1.2 MB");
	});

	it("GB 级", () => {
		expect(formatBytes(1024 * 1024 * 1024 * 3.1)).toBe("3.1 GB");
	});

	it("负数与非有限数返回空串", () => {
		expect(formatBytes(-1)).toBe("");
		expect(formatBytes(Number.NaN)).toBe("");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
	});
});
