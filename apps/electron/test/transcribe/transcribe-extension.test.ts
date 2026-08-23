// ============================================================
// transcribe-extension tests — 转录稿落盘路径
//
// 回归点：完整转录稿必须写入项目共享区（`shared/<projectId>/transcripts/`），
// 而不是系统临时目录 —— 临时目录会被系统清理，用户点击消息里的路径时
// 会看到"文件不存在"。无项目时回退 tmpdir。
// ============================================================

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveFullTranscript, transcriptFileBase } from "../../src/main/extensions/transcribe-extension";

describe("transcribe transcript save", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "look-transcribe-ext-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("transcriptFileBase 去掉扩展名并转义非法字符", () => {
		expect(transcriptFileBase("/Users/x/会议 录音 v1.mp3")).toBe("会议_录音_v1");
		expect(transcriptFileBase("meeting.m4a")).toBe("meeting");
		expect(transcriptFileBase("/tmp/中文.wav")).toBe("中文");
		expect(transcriptFileBase("archive.tar.gz")).toBe("archive.tar");
	});

	it("有共享区时写入共享区 transcripts 目录（文件名带源名与时间戳）", async () => {
		const sharedDir = join(dir, "shared", "proj-1", "transcripts");
		const path = await saveFullTranscript("你好，这是转录内容。", sharedDir, "/Users/x/meeting.mp3");

		expect(path.startsWith(sharedDir)).toBe(true);
		expect(path).toMatch(/meeting\.transcript-\d+\.txt$/);
		expect(await readFile(path, "utf8")).toBe("你好，这是转录内容。\n");
		// 目录递归创建。
		expect((await readdir(join(dir, "shared", "proj-1"))).sort()).toEqual(["transcripts"]);
	});

	it("无共享区时回退系统临时目录", async () => {
		const path = await saveFullTranscript("fallback text", null, "/Users/x/meeting.mp3");

		expect(path).toMatch(/look-transcribe-/);
		expect(path.endsWith("transcript.txt")).toBe(true);
		expect(await readFile(path, "utf8")).toBe("fallback text\n");
		await rm(join(path, ".."), { recursive: true, force: true });
	});
});
