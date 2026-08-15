// ============================================================
// AttachmentService tests — LOOK_HOME 隔离（AGENTS.md Testing isolation）
//
// AttachmentService 静态 import 链会绑定 look-storage 模块缓存的
// LOOK_DIR，必须 vi.stubEnv + vi.resetModules + 动态 import。
// ============================================================

import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("AttachmentService", () => {
	let tempDir: string;
	let lookStorage: typeof import("@look/shared/look-storage");
	let mod: typeof import("../../src/main/session/services/attachment-service.js");
	let service: import("../../src/main/session/services/attachment-service.js").AttachmentService;

	const PROJECT_ID = "proj-abc123";
	const SESSION_ID = "session-abc123";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "look-attachments-"));
		vi.stubEnv("LOOK_HOME", tempDir);
		vi.resetModules();
		lookStorage = await import("@look/shared/look-storage");
		mod = await import("../../src/main/session/services/attachment-service.js");
		service = new mod.AttachmentService();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("creates an attachment under LOOK_HOME/attachments/<projectId>/<sessionId>/<name>", () => {
		const attachment = service.createAttachment(PROJECT_ID, SESSION_ID, "paste-1.md", "# 标题\n正文");

		expect(attachment).toMatchObject({
			projectId: PROJECT_ID,
			sessionId: SESSION_ID,
			name: "paste-1.md",
			mimeType: "text/markdown",
			sizeBytes: Buffer.byteLength("# 标题\n正文", "utf8"),
		});
		expect(attachment.path).toBe(path.join(lookStorage.getAttachmentsDir(PROJECT_ID, SESSION_ID), "paste-1.md"));
		expect(fs.existsSync(attachment.path)).toBe(true);
		expect(fs.readFileSync(attachment.path, "utf8")).toBe("# 标题\n正文");
	});

	it("rejects attachment names with path traversal or separators", () => {
		expect(() => mod.assertAttachmentName("../../etc/passwd")).toThrow();
		expect(() => mod.assertAttachmentName("a/b.md")).toThrow();
		expect(() => mod.assertAttachmentName("")).toThrow();
		expect(() => mod.assertAttachmentName(".hidden")).toThrow();
		expect(() => mod.assertAttachmentName("..")).toThrow();
		expect(mod.assertAttachmentName("paste-1.md")).toBe("paste-1.md");
	});

	it("rejects content larger than the 10MB limit", () => {
		const big = "x".repeat(mod.ATTACHMENT_MAX_BYTES + 1);
		expect(() => service.createAttachment(PROJECT_ID, SESSION_ID, "big.txt", big)).toThrow(/exceeds max size/);
	});

	it("round-trips read/update/delete", () => {
		service.createAttachment(PROJECT_ID, SESSION_ID, "a.txt", "hello");
		expect(service.readAttachment(PROJECT_ID, SESSION_ID, "a.txt")).toEqual({
			content: "hello",
			sizeBytes: 5,
		});

		service.updateAttachment(PROJECT_ID, SESSION_ID, "a.txt", "hello edited");
		expect(service.readAttachment(PROJECT_ID, SESSION_ID, "a.txt").content).toBe("hello edited");

		service.deleteAttachment(PROJECT_ID, SESSION_ID, "a.txt");
		expect(() => service.readAttachment(PROJECT_ID, SESSION_ID, "a.txt")).toThrow();
		// 幂等删除
		expect(() => service.deleteAttachment(PROJECT_ID, SESSION_ID, "a.txt")).not.toThrow();
	});

	it("deleteSessionAttachments removes the whole session directory", () => {
		service.createAttachment(PROJECT_ID, SESSION_ID, "a.txt", "1");
		service.createAttachment(PROJECT_ID, SESSION_ID, "b.md", "2");
		service.deleteSessionAttachments(PROJECT_ID, SESSION_ID);
		expect(fs.existsSync(lookStorage.getAttachmentsDir(PROJECT_ID, SESSION_ID))).toBe(false);
	});

	it("deleteProjectAttachments removes every session directory under the project", () => {
		service.createAttachment(PROJECT_ID, SESSION_ID, "a.txt", "1");
		service.createAttachment(PROJECT_ID, "session-other1", "b.md", "2");
		service.deleteProjectAttachments(PROJECT_ID);
		expect(fs.existsSync(path.join(lookStorage.getAttachmentsRootDir(), PROJECT_ID))).toBe(false);
		// 根目录保留（其他项目不受影响）
		expect(fs.existsSync(lookStorage.getAttachmentsRootDir())).toBe(true);
	});

	describe("buildPrompt", () => {
		it("returns text unchanged when there are no attachments", () => {
			expect(service.buildPrompt("hello", [])).toBe("hello");
		});

		it("inlines small attachment content after the text", () => {
			service.createAttachment(PROJECT_ID, SESSION_ID, "paste-1.md", "# 内容\nline");
			const prompt = service.buildPrompt("分析这个", [
				{ projectId: PROJECT_ID, sessionId: SESSION_ID, name: "paste-1.md" },
			]);
			expect(prompt).toContain("分析这个");
			expect(prompt).toContain("[Attachment: paste-1.md]\n# 内容\nline\n[/Attachment]");
		});

		it("degrades oversized attachments to a path reference + preview", () => {
			const big = "y".repeat(mod.ATTACHMENT_INLINE_MAX_BYTES + 100);
			service.createAttachment(PROJECT_ID, SESSION_ID, "big.txt", big);
			const prompt = service.buildPrompt("", [{ projectId: PROJECT_ID, sessionId: SESSION_ID, name: "big.txt" }]);
			// 统一标记格式：`[Attachment: name — note]\n<preview>\n[/Attachment]`
			expect(prompt).toMatch(/^\[Attachment: big\.txt — .*exceeds the inline limit.*\]\n/);
			expect(prompt).toContain("read_file");
			expect(prompt).toContain(path.join(lookStorage.getAttachmentsDir(PROJECT_ID, SESSION_ID), "big.txt"));
			expect(prompt.endsWith("[/Attachment]")).toBe(true);
			// 只带摘要，不内联全文
			expect(prompt).not.toContain(big);
			expect(prompt).toContain(big.slice(0, mod.ATTACHMENT_PREVIEW_MAX_BYTES));
		});

		it("tolerates a missing attachment file with a notice", () => {
			const prompt = service.buildPrompt("hi", [{ projectId: PROJECT_ID, sessionId: SESSION_ID, name: "gone.txt" }]);
			expect(prompt).toContain("file missing");
			expect(prompt).toContain("\n[/Attachment]");
		});
	});
});
