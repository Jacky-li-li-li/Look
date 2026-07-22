import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		flush: vi.fn(async () => {}),
	};
}

function makeStore() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-ai-avatar-"));
	tempDirectories.push(directory);
	const settingsPath = path.join(directory, "ui-settings.json");
	return { settingsPath, store: new UserSettingsStore(settingsManager() as never, settingsPath) };
}

describe("UserSettingsStore aiAvatar", () => {
	it("默认为 null", () => {
		const { store } = makeStore();
		expect(store.getAll().aiAvatar).toBeNull();
	});

	it("update 后 getAll 返回所选头像，重新实例化后仍持久", async () => {
		const { store, settingsPath } = makeStore();

		const updated = await store.update({ aiAvatar: "avatar-03" });
		expect(updated.aiAvatar).toBe("avatar-03");
		expect(store.getAll().aiAvatar).toBe("avatar-03");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).aiAvatar).toBe("avatar-03");

		const reloaded = new UserSettingsStore(settingsManager() as never, settingsPath);
		expect(reloaded.getAll().aiAvatar).toBe("avatar-03");
	});

	it("reset 后回到 null", async () => {
		const { store } = makeStore();

		await store.update({ aiAvatar: "avatar-03" });
		const reset = await store.reset();
		expect(reset.aiAvatar).toBeNull();
		expect(store.getAll().aiAvatar).toBeNull();
	});
});
