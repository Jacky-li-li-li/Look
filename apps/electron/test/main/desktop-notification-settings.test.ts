// ============================================================
// desktop-notification-settings tests — 设置开关三态校验与持久化
//
// 覆盖：UserSettingsStore 对新字段 desktopNotifications 的默认值、
// 持久化 update 路径，以及 settings:general:set 的 guardEnum 校验。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardEnum } from "../../src/main/ipc/guards.js";
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

describe("DesktopNotificationMode settings", () => {
	it("默认值为 all", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-notif-settings-"));
		tempDirectories.push(directory);
		const store = new UserSettingsStore(settingsManager() as never, path.join(directory, "ui-settings.json"));
		expect(store.getAll().desktopNotifications).toBe("all");
	});

	it("update 持久化三态并写盘", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-notif-settings-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		await store.update({ desktopNotifications: "off" });
		expect(store.getAll().desktopNotifications).toBe("off");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).desktopNotifications).toBe("off");

		await store.update({ desktopNotifications: "needs-action" });
		expect(store.getAll().desktopNotifications).toBe("needs-action");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).desktopNotifications).toBe("needs-action");

		await store.update({ desktopNotifications: "all" });
		expect(store.getAll().desktopNotifications).toBe("all");
	});

	it("老配置文件缺失字段时回退到默认 all", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-notif-settings-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ language: "en" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);
		expect(store.getAll().desktopNotifications).toBe("all");
	});

	it("guardEnum 接受三态并拒绝非法值", () => {
		const values = ["off", "needs-action", "all"] as const;
		expect(guardEnum("all", "settings.desktopNotifications", values)).toBe("all");
		expect(guardEnum("needs-action", "settings.desktopNotifications", values)).toBe("needs-action");
		expect(guardEnum("off", "settings.desktopNotifications", values)).toBe("off");
		expect(() => guardEnum("banana", "settings.desktopNotifications", values)).toThrow(/Invalid/);
		expect(() => guardEnum(42, "settings.desktopNotifications", values)).toThrow(/Invalid/);
	});
});
