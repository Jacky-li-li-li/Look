// ============================================================
// Vitest — readFileContent / writeFileContent 纯函数单元测试
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileContent, writeFileContent } from "../../src/main/ipc/routers/file-router.js";

const READ_CAP = 4 * 1024 * 1024;
const WRITE_CAP = 10 * 1024 * 1024;

describe("file content read/write", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-file-content-test-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("readFileContent returns text content for a utf8 file", async () => {
		const filePath = path.join(dir, "hello.txt");
		const content = "hello 你好, world!\n第二行";
		fs.writeFileSync(filePath, content, "utf8");
		const result = await readFileContent(filePath);
		expect(result.success).toBe(true);
		expect(result.kind).toBe("text");
		if (result.kind !== "text") throw new Error("expected text result");
		expect(result.content).toBe(content);
		expect(result.truncated).toBe(false);
		expect(result.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
	});

	it("readFileContent truncates files larger than 4MB to exactly 4MB", async () => {
		const filePath = path.join(dir, "big.txt");
		fs.writeFileSync(filePath, "a".repeat(READ_CAP + 1), "utf8");
		const result = await readFileContent(filePath);
		expect(result.success).toBe(true);
		expect(result.kind).toBe("text");
		if (result.kind !== "text") throw new Error("expected text result");
		expect(result.truncated).toBe(true);
		expect(result.sizeBytes).toBe(READ_CAP + 1);
		expect(result.content.length).toBe(READ_CAP);
		expect(result.content).toBe("a".repeat(READ_CAP));
	});

	it("readFileContent detects binary files via NUL byte and returns no content", async () => {
		const filePath = path.join(dir, "bin.dat");
		fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0a]));
		const result = await readFileContent(filePath);
		expect(result).toEqual({ success: true, kind: "binary", sizeBytes: 5 });
		expect("content" in result).toBe(false);
	});

	it("readFileContent rejects a directory path", async () => {
		await expect(readFileContent(dir)).rejects.toThrow(/Not a file/);
	});

	it("readFileContent rejects a nonexistent file", async () => {
		await expect(readFileContent(path.join(dir, "missing.txt"))).rejects.toThrow(/ENOENT|no such file/);
	});

	it("writeFileContent writes utf8 that reads back identical", async () => {
		const filePath = path.join(dir, "out.txt");
		const content = "写入内容 🚀 line1\nline2";
		const result = await writeFileContent(filePath, content);
		expect(result).toEqual({ success: true, sizeBytes: Buffer.byteLength(content, "utf8") });
		expect(fs.readFileSync(filePath, "utf8")).toBe(content);
		// 通过 readFileContent 读回也应一致
		const readBack = await readFileContent(filePath);
		if (readBack.kind !== "text") throw new Error("expected text result");
		expect(readBack.content).toBe(content);
	});

	it("writeFileContent rejects a directory path", async () => {
		await expect(writeFileContent(dir, "x")).rejects.toThrow(/directory/);
	});

	it("writeFileContent rejects content larger than 10MB", async () => {
		const filePath = path.join(dir, "too-big.txt");
		await expect(writeFileContent(filePath, "x".repeat(WRITE_CAP + 1))).rejects.toThrow(/exceeds max size/);
		expect(fs.existsSync(filePath)).toBe(false);
	});
});
