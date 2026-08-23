// ============================================================
// attachment-service buildPrompt — 音视频附件不按文本读取
// ============================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAttachmentsDir } from "@look/shared/look-storage";
import type { AttachmentRef } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import {
	ATTACHMENT_MAX_BYTES,
	AttachmentService,
	resolveAttachmentPath,
} from "../src/main/session/services/attachment-service";

const attachmentService = new AttachmentService();

describe("attachment-service buildPrompt（音视频附件）", () => {
	const projectId = "p1";
	const sessionId = "s1";
	const dir = getAttachmentsDir(projectId, sessionId);

	async function seed(name: string, content: Buffer | string): Promise<AttachmentRef> {
		await mkdir(dir, { recursive: true });
		await writeFile(resolveAttachmentPath(projectId, sessionId, name), content);
		return { projectId, sessionId, name };
	}

	it("音频附件不读内容、提示先询问用户再转写", async () => {
		// 伪音频文件：二进制乱码（模拟真实音频）
		const ref = await seed("meeting.m4a", Buffer.from([0x00, 0xff, 0x13, 0x37, 0xab, 0xcd, 0x42, 0x99]));
		const prompt = attachmentService.buildPrompt("请处理这个文件", [ref]);

		expect(prompt).toContain("[Media attachment: meeting.m4a");
		expect(prompt).toContain("do not read it as text");
		expect(prompt).toContain("ask the user first");
		expect(prompt).toContain("transcribe_file");
		// 乱码不应出现在 prompt 中
		expect(prompt).not.toContain("\u0000");
	});

	it("视频附件同样走媒体分支", async () => {
		const ref = await seed("demo.mp4", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x88, 0x42, 0x11, 0x22]));
		const prompt = attachmentService.buildPrompt("", [ref]);
		expect(prompt).toContain("[Media attachment: demo.mp4");
	});

	it("文本附件行为不变（内联内容）", async () => {
		const ref = await seed("note.txt", "hello world");
		const prompt = attachmentService.buildPrompt("", [ref]);
		expect(prompt).toContain("[Attachment: note.txt]");
		expect(prompt).toContain("hello world");
	});
});

describe("attachment-service importAttachmentFromPath（按字节导入媒体）", () => {
	const projectId = "p-media";
	const sessionId = "s-media";
	const dir = getAttachmentsDir(projectId, sessionId);

	it("源文件字节原样拷贝，不经过文本解码", async () => {
		const src = path.join(dir, "source.mp4");
		const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x88, 0x42, 0x11, 0x22]);
		await mkdir(dir, { recursive: true });
		await writeFile(src, bytes);

		const att = attachmentService.importAttachmentFromPath(projectId, sessionId, "copy.mp4", src, "video/mp4");
		expect(att.sizeBytes).toBe(bytes.length);
		expect(att.mimeType).toBe("video/mp4");
		expect(att.name).toBe("copy.mp4");

		const stored = await readFile(resolveAttachmentPath(projectId, sessionId, "copy.mp4"));
		expect(stored.equals(bytes)).toBe(true);
	});

	it("未传 mimeType 时按扩展名推导", async () => {
		const src = path.join(dir, "source.m4a");
		const bytes = Buffer.from([0x00, 0xff, 0x13, 0x37]);
		await mkdir(dir, { recursive: true });
		await writeFile(src, bytes);

		const att = attachmentService.importAttachmentFromPath(projectId, sessionId, "copy.m4a", src);
		expect(att.sizeBytes).toBe(bytes.length);
		// .m4a 不在文本扩展名表里 → 回落 text/plain；mimeType 仅作信息展示
		expect(att.mimeType).toBe("text/plain");
	});

	it("超过上限的源文件拒绝导入", async () => {
		const src = path.join(dir, "big.mp4");
		await mkdir(dir, { recursive: true });
		await writeFile(src, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));

		expect(() => attachmentService.importAttachmentFromPath(projectId, sessionId, "big.mp4", src)).toThrow(
			/exceeds max size/,
		);
	});

	it("源文件不存在时抛出 ENOENT", async () => {
		expect(() =>
			attachmentService.importAttachmentFromPath(projectId, sessionId, "ghost.mp4", path.join(dir, "nope.mp4")),
		).toThrow();
	});
});
