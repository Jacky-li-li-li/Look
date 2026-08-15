// ============================================================
// pasteAttachment 渲染端纯函数测试（阈值判定 / 命名 / 标记解析）
// ============================================================

import { describe, expect, it } from "vitest";
import {
	buildAttachmentName,
	guessAttachmentExtension,
	parseAttachmentMessage,
	sanitizeAttachmentName,
	shouldConvertPasteToAttachment,
} from "../src/renderer/lib/pasteAttachment";

describe("shouldConvertPasteToAttachment", () => {
	it("keeps short pastes as plain text", () => {
		expect(shouldConvertPasteToAttachment("hello world")).toBe(false);
		expect(shouldConvertPasteToAttachment("")).toBe(false);
	});

	it("converts pastes above the line threshold", () => {
		const text = Array.from({ length: 61 }, (_, i) => `line ${i}`).join("\n");
		expect(shouldConvertPasteToAttachment(text)).toBe(true);
	});

	it("converts pastes above the char threshold", () => {
		expect(shouldConvertPasteToAttachment("x".repeat(2001))).toBe(true);
	});

	it("converts code-heavy snippets below both thresholds", () => {
		const lines = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? `  const x${i} = {` : `    key${i}: 1,`));
		expect(shouldConvertPasteToAttachment(lines.join("\n"))).toBe(true);
	});
});

describe("guessAttachmentExtension", () => {
	it("detects markdown", () => {
		expect(guessAttachmentExtension("# 标题\n- 列表")).toBe("md");
		expect(guessAttachmentExtension("> 引用")).toBe("md");
	});

	it("detects json", () => {
		expect(guessAttachmentExtension('{"a": 1, "b": [2]}')).toBe("json");
	});

	it("detects logs", () => {
		const log = ["[ERROR] boom", "2026-02-10 12:00:01 x", "[INFO] ok", "2026-02-10 12:00:02 y"].join("\n");
		expect(guessAttachmentExtension(log)).toBe("log");
	});

	it("falls back to txt", () => {
		expect(guessAttachmentExtension("just some plain words\nacross two lines")).toBe("txt");
	});
});

describe("buildAttachmentName", () => {
	it("produces paste-<stamp>-<seq>.<ext>", () => {
		const name = buildAttachmentName("# heading", 1);
		expect(name).toMatch(/^paste-\d{8}-\d{4}-1\.md$/);
	});
});

describe("sanitizeAttachmentName", () => {
	it("keeps valid names (CJK / spaces / dots in extension)", () => {
		expect(sanitizeAttachmentName("需求文档.md")).toBe("需求文档.md");
		expect(sanitizeAttachmentName("error log 2026.txt")).toBe("error log 2026.txt");
	});

	it("strips path separators and marker-conflicting chars", () => {
		expect(sanitizeAttachmentName("a/b\\c.txt")).toBe("a-b-c.txt");
		// `]` 与全角破折号被替换为 `-`（保留空格，仍是合法文件名）
		expect(sanitizeAttachmentName("x]y — z.md")).toBe("x-y - z.md");
		expect(sanitizeAttachmentName("..\\evil")).toBe("evil");
	});

	it("strips the leading dot of hidden files", () => {
		expect(sanitizeAttachmentName(".env")).toBe("env");
	});

	it("returns null when nothing usable remains", () => {
		expect(sanitizeAttachmentName("///")).toBeNull();
		expect(sanitizeAttachmentName("...")).toBeNull();
		expect(sanitizeAttachmentName("  ")).toBeNull();
	});
});

describe("parseAttachmentMessage", () => {
	it("returns a single text segment when there is no marker", () => {
		expect(parseAttachmentMessage("plain text")).toEqual([{ type: "text", text: "plain text" }]);
	});

	it("parses an inline attachment block", () => {
		const segments = parseAttachmentMessage("分析这个\n\n[Attachment: paste-1.md]\n# 标题\n正文\n[/Attachment]");
		expect(segments).toEqual([
			{ type: "text", text: "分析这个\n\n" },
			{ type: "attachment", name: "paste-1.md", note: undefined, content: "# 标题\n正文" },
		]);
	});

	it("parses name — note and empty content (missing/oversized blocks)", () => {
		const segments = parseAttachmentMessage(
			"[Attachment: big.txt — 41200 bytes, stored at /x, exceeds the inline limit]\npreview\n[/Attachment]",
		);
		expect(segments).toEqual([
			{
				type: "attachment",
				name: "big.txt",
				note: "41200 bytes, stored at /x, exceeds the inline limit",
				content: "preview",
			},
		]);
	});

	it("parses multiple blocks with text between them", () => {
		const text = "a\n[Attachment: one.md]\n1\n[/Attachment]\nmid\n[Attachment: two.txt]\n2\n[/Attachment]\nz";
		const segments = parseAttachmentMessage(text);
		expect(segments).toEqual([
			{ type: "text", text: "a\n" },
			{ type: "attachment", name: "one.md", note: undefined, content: "1" },
			{ type: "text", text: "\nmid\n" },
			{ type: "attachment", name: "two.txt", note: undefined, content: "2" },
			{ type: "text", text: "\nz" },
		]);
	});
});
