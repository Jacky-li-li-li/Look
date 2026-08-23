// ============================================================
// transcribe settings tests — normalize 不丢显式选择的中文输出
// ============================================================

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function mockLocale(locale: string): void {
	vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
		resolvedOptions: () => ({ locale }),
	} as Intl.DateTimeFormat);
}

describe("transcribe settings", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "look-transcribe-settings-"));
		vi.stubEnv("LOOK_HOME", home);
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("显式 simplified 不被系统 locale 默认值覆盖", async () => {
		// zh-TW 系统的 locale 默认是繁体，但用户显式保存的 simplified 必须原样保留。
		mockLocale("zh-TW");
		await writeFile(
			join(home, "transcribe.json"),
			JSON.stringify({
				version: 1,
				modelId: "Qwen3-ASR-0.6B",
				transcriptionLanguage: "auto",
				chineseOutput: "simplified",
			}),
		);
		const { readTranscribeSettings } = await import("../../src/main/transcribe/settings.js");
		expect(readTranscribeSettings().chineseOutput).toBe("simplified");
	});

	it("显式繁体值原样保留", async () => {
		mockLocale("zh-CN");
		await writeFile(
			join(home, "transcribe.json"),
			JSON.stringify({
				version: 1,
				modelId: "Qwen3-ASR-0.6B",
				transcriptionLanguage: "auto",
				chineseOutput: "traditional-hong-kong",
			}),
		);
		const { readTranscribeSettings } = await import("../../src/main/transcribe/settings.js");
		expect(readTranscribeSettings().chineseOutput).toBe("traditional-hong-kong");
	});

	it("缺失/非法值回退 locale 默认", async () => {
		mockLocale("zh-TW");
		await writeFile(
			join(home, "transcribe.json"),
			JSON.stringify({ version: 1, modelId: "Qwen3-ASR-0.6B", transcriptionLanguage: "auto", chineseOutput: 42 }),
		);
		const { readTranscribeSettings } = await import("../../src/main/transcribe/settings.js");
		expect(readTranscribeSettings().chineseOutput).toBe("traditional-taiwan");
	});

	it("文件缺失时回退默认设置", async () => {
		mockLocale("en-US");
		const { readTranscribeSettings } = await import("../../src/main/transcribe/settings.js");
		const settings = readTranscribeSettings();
		expect(settings.modelId).toBe("Qwen3-ASR-0.6B");
		expect(settings.transcriptionLanguage).toBe("auto");
		expect(settings.chineseOutput).toBe("simplified");
	});
});
