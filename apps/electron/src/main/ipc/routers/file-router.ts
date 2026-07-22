// ============================================================
// File router — direct file read/write for the renderer
// ============================================================

import fs from "node:fs";
import { guardPath } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/** 读取上限 4MB,超出部分截断返回。 */
const FILE_READ_MAX_BYTES = 4 * 1024 * 1024;
/** 写入上限 10MB(guardString 的 100KB 上限太小,这里手动校验字节数)。 */
const FILE_WRITE_MAX_BYTES = 10 * 1024 * 1024;
/** 二进制嗅探窗口:前 8KB 内出现 NUL 字节即视为二进制文件。 */
const BINARY_SNIFF_BYTES = 8 * 1024;

export type FileReadResult =
	| { success: true; kind: "text"; content: string; truncated: boolean; sizeBytes: number }
	| { success: true; kind: "binary"; sizeBytes: number };

export interface FileWriteResult {
	success: true;
	sizeBytes: number;
}

/** 读取文件内容:>4MB 只读前 4MB 并标记截断;前 8KB 含 NUL 字节视为二进制,不解码。 */
export async function readFileContent(filePath: string): Promise<FileReadResult> {
	const stat = await fs.promises.lstat(filePath);
	if (!stat.isFile()) {
		throw new Error(`Not a file: ${filePath}`);
	}
	const sizeBytes = stat.size;
	const truncated = sizeBytes > FILE_READ_MAX_BYTES;
	const length = Math.min(sizeBytes, FILE_READ_MAX_BYTES);
	const handle = await fs.promises.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(length);
		if (length > 0) {
			await handle.read(buffer, 0, length, 0);
		}
		if (buffer.subarray(0, Math.min(length, BINARY_SNIFF_BYTES)).includes(0)) {
			return { success: true, kind: "binary", sizeBytes };
		}
		return { success: true, kind: "text", content: buffer.toString("utf8"), truncated, sizeBytes };
	} finally {
		await handle.close();
	}
}

/** 写入 utf8 文本:>10MB 拒绝;路径已存在且是目录时拒绝;不创建父目录。 */
export async function writeFileContent(filePath: string, content: string): Promise<FileWriteResult> {
	const sizeBytes = Buffer.byteLength(content, "utf8");
	if (sizeBytes > FILE_WRITE_MAX_BYTES) {
		throw new Error(`Invalid content: exceeds max size ${FILE_WRITE_MAX_BYTES} bytes`);
	}
	const existing = await fs.promises.lstat(filePath).catch(() => null);
	if (existing?.isDirectory()) {
		throw new Error(`Cannot write to directory path: ${filePath}`);
	}
	await fs.promises.writeFile(filePath, content, "utf8");
	return { success: true, sizeBytes };
}

/** 路径类型探测:点击文件路径芯片前先 stat,目录改走 Finder 展示,不打开查看器。 */
export type PathKind = "file" | "directory" | "other" | "missing";

export interface PathStatResult {
	success: true;
	kind: PathKind;
}

export async function statPathKind(filePath: string): Promise<PathStatResult> {
	// 使用 stat(而非 lstat)跟随符号链接:指向目录的软链也按目录分类,以便在 Finder 中展示。
	const stat = await fs.promises.stat(filePath).catch(() => null);
	if (!stat) return { success: true, kind: "missing" };
	if (stat.isDirectory()) return { success: true, kind: "directory" };
	if (!stat.isFile()) return { success: true, kind: "other" };
	return { success: true, kind: "file" };
}

export const fileRouter: IpcRouter = (_ctx, register) => {
	register("file:read", async (data) => readFileContent(guardPath(data.path, "path")));

	register("file:write", async (data) => {
		const filePath = guardPath(data.path, "path");
		const content: unknown = data.content;
		if (typeof content !== "string") {
			throw new Error(`Invalid content: expected string, got ${typeof content}`);
		}
		return writeFileContent(filePath, content);
	});

	register("file:stat", async (data) => statPathKind(guardPath(data.path, "path")));
};
