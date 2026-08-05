// ============================================================
// showToolExecution settings tests — 工具组开关默认值与持久化
//
// 覆盖：UserSettingsStore 对新字段 showToolExecution 的默认值、
// 持久化 update 路径，以及 settings:general:set 的 guardBoolean 校验。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardBoolean } from "../../src/main/ipc/guards.js";
import { UserSettingsStore } from "../../src/main/settings/store.js";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function settingsManager() {
	return {
		getDefaultProvider: () => undefined,
		getDefaultModel: () => undefined,
		setDefaultModelAndProvider: vi.fn(),
		setDefaultProvider: vi.fn(),
		setDefaultModel: vi.fn(),
		getCompactionEnabled: () => true,
		setCompactionEnabled: vi.fn(),
		getCompactionReserveTokens: () => 16384,
		getCompactionKeepRecentTokens: () => 20000,
		flush: vi.fn(async () => {}),
	};
}

describe("showToolExecution settings", () => {
	it("默认值为 true（显示工具组）", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-tool-exec-settings-"));
		tempDirectories.push(directory);
		const store = new UserSettingsStore(settingsManager() as never, path.join(directory, "ui-settings.json"));
		expect(store.getAll().showToolExecution).toBe(true);
	});

	it("update 持久化 false 并写盘", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-tool-exec-settings-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		await store.update({ showToolExecution: false });
		expect(store.getAll().showToolExecution).toBe(false);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).showToolExecution).toBe(false);

		await store.update({ showToolExecution: true });
		expect(store.getAll().showToolExecution).toBe(true);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).showToolExecution).toBe(true);
	});

	it("老配置文件缺失字段时回退默认 true", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-tool-exec-settings-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ language: "en" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);
		expect(store.getAll().showToolExecution).toBe(true);
	});

	it("guardBoolean 接受布尔值并拒绝非法值", () => {
		expect(guardBoolean(true, "settings.showToolExecution")).toBe(true);
		expect(guardBoolean(false, "settings.showToolExecution")).toBe(false);
		expect(() => guardBoolean("yes", "settings.showToolExecution")).toThrow(/Invalid/);
		expect(() => guardBoolean(1, "settings.showToolExecution")).toThrow(/Invalid/);
	});
});
