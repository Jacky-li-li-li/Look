// ============================================================
// 用户数据 JSON 损坏回退 — 必须先备份原件，不得静默覆盖
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJsonFileWithCorruptBackup } from "../../src/main/utils/atomic-writer.js";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "look-atomic-"));
}

describe("readJsonFileWithCorruptBackup", () => {
	it("缺失文件返回 fallback，且不产生备份", () => {
		const dir = tempDir();
		try {
			expect(readJsonFileWithCorruptBackup(path.join(dir, "missing.json"), { a: 1 })).toEqual({ a: 1 });
			expect(fs.readdirSync(dir)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("损坏文件先备份再返回 fallback", () => {
		const dir = tempDir();
		const file = path.join(dir, "db.json");
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			fs.writeFileSync(file, "{ not json");

			expect(readJsonFileWithCorruptBackup(file, null)).toBeNull();
			expect(fs.existsSync(file)).toBe(false);

			const backups = fs.readdirSync(dir).filter((name) => name.startsWith("db.json.corrupt-"));
			expect(backups).toHaveLength(1);
			expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe("{ not json");
		} finally {
			spy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("合法文件正常解析", () => {
		const dir = tempDir();
		const file = path.join(dir, "ok.json");
		try {
			fs.writeFileSync(file, JSON.stringify({ ok: true }));
			expect(readJsonFileWithCorruptBackup(file, null)).toEqual({ ok: true });
			expect(fs.readdirSync(dir)).toEqual(["ok.json"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
