// ============================================================
// AtomicWriter — tmp + rename 原子写入工具
//
// 统一持久化层的 JSON / 文本 / Markdown 文件写入，确保
// 写入过程中崩溃不会产生损坏文件。替换各处散落的直接
// writeFileSync 调用。
// ============================================================

import fs from "node:fs";
import path from "node:path";

function ensureDir(filePath: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
}

export function writeJsonFile(filePath: string, data: unknown, pretty = true): void {
	ensureDir(filePath);
	const tmp = `${filePath}.tmp`;
	const json = JSON.stringify(data, null, pretty ? "\t" : undefined);
	fs.writeFileSync(tmp, json, "utf8");
	fs.renameSync(tmp, filePath);
}

export function writeTextFile(filePath: string, content: string): void {
	ensureDir(filePath);
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function readJsonFileOptional<T>(filePath: string): T | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
