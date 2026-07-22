import { describe, expect, it } from "vitest";
import { coalesceChildren, looksLikeFilePath, resolveToAbsolutePath } from "../src/renderer/lib/filePathDetection";

describe("looksLikeFilePath", () => {
	it.each([
		// 绝对路径 / ~ 路径 / Windows 盘符路径 → 是路径
		["/Users/jacky/.look/default-workspace/Look/daily-report-2026-07-17.md", true],
		["~/docs/a.md", true],
		["C:\\Users\\a\\b.txt", true],
		["/etc/hosts", true],
		// URL / 非路径文本 / 含空白 → 不是路径
		["https://example.com/x", false],
		["file:///etc/passwd", false],
		["/skill:commit", false],
		["/", false],
		["hello", false],
		["a b/c.md", false],
		["", false],
	])("%s → %s", (input, expected) => {
		expect(looksLikeFilePath(input)).toBe(expected);
	});
});

describe("resolveToAbsolutePath", () => {
	it("expands ~ to homedir", () => {
		expect(resolveToAbsolutePath("~/x", "/h")).toBe("/h/x");
	});

	it("joins relative paths with projectCwd", () => {
		expect(resolveToAbsolutePath("src/a.ts", "/h", "/p")).toBe("/p/src/a.ts");
	});

	it("strips a leading ./ before joining projectCwd", () => {
		expect(resolveToAbsolutePath("./a.ts", "/h", "/p")).toBe("/p/a.ts");
	});

	it("passes absolute paths through unchanged", () => {
		expect(resolveToAbsolutePath("/a/b.md", "/h")).toBe("/a/b.md");
		expect(resolveToAbsolutePath("C:\\a\\b.txt", "/h")).toBe("C:\\a\\b.txt");
	});

	it("passes relative paths through unchanged without projectCwd", () => {
		expect(resolveToAbsolutePath("src/a.ts", "/h")).toBe("src/a.ts");
		expect(resolveToAbsolutePath("src/a.ts", "/h", null)).toBe("src/a.ts");
	});
});

describe("coalesceChildren", () => {
	it("returns a single string as-is", () => {
		expect(coalesceChildren("/a/b.md")).toBe("/a/b.md");
	});

	it("joins an array of strings", () => {
		expect(coalesceChildren(["/a/", "b.md"])).toBe("/a/b.md");
	});

	it("joins nested arrays", () => {
		expect(coalesceChildren(["/a/", ["b", ".md"]])).toBe("/a/b.md");
	});

	it("stringifies numbers", () => {
		expect(coalesceChildren(42)).toBe("42");
		expect(coalesceChildren(["/v", 1, ".", 0])).toBe("/v1.0");
	});

	it("ignores null/undefined mixed into arrays", () => {
		expect(coalesceChildren([null, "/a", undefined, "b.md"])).toBe("/ab.md");
		expect(coalesceChildren(null)).toBe("");
		expect(coalesceChildren(undefined)).toBe("");
	});
});
