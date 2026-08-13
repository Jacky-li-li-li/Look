// ============================================================
// sensitive-paths 单元测试
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模块级缓存（getLookDir 读 look-storage 的 LOOK_DIR）——每次 beforeEach
// stub 后 resetModules + 动态 import，保证绑定到当前 LOOK_HOME。
async function loadSensitivePaths() {
	vi.resetModules();
	return import("../../src/main/security/sensitive-paths.js");
}

describe("isSensitivePath", () => {
	let tempHome: string;
	let lookHome: string;

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "look-home-"));
		// LOOK_HOME 放在 home 内且为 dot 目录，复现真实 ~/.look 场景
		lookHome = path.join(tempHome, ".look");
		fs.mkdirSync(lookHome, { recursive: true });
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("LOOK_HOME", lookHome);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("rejects dot paths under home (credentials/config)", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		expect(isSensitivePath(path.join(tempHome, ".zshrc"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, ".ssh", "id_rsa"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, ".config", "gh", "hosts.yml"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, ".aws", "credentials"))).toBe(true);
	});

	it("allows ordinary non-dot paths under home", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		expect(isSensitivePath(path.join(tempHome, "Downloads"))).toBe(false);
		expect(isSensitivePath(path.join(tempHome, "Documents", "notes.txt"))).toBe(false);
		expect(isSensitivePath(path.join(tempHome, "Projects", "pi", "src"))).toBe(false);
	});

	it("rejects LOOK_HOME credential files even though LOOK_HOME is a dot dir", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		expect(isSensitivePath(path.join(lookHome, "auth.json"))).toBe(true);
		expect(isSensitivePath(path.join(lookHome, "models.json"))).toBe(true);
		expect(isSensitivePath(path.join(lookHome, "custom-providers.json"))).toBe(true);
		expect(isSensitivePath(path.join(lookHome, "im-bindings.json"))).toBe(true);
		expect(isSensitivePath(path.join(lookHome, "projects", "p1", "settings.json"))).toBe(true);
	});

	it("allows the project shared area inside LOOK_HOME", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		expect(isSensitivePath(path.join(lookHome, "shared", "p1", "notes.md"))).toBe(false);
		expect(isSensitivePath(path.join(lookHome, "shared"))).toBe(false);
	});

	it("rejects macOS Library persistence dirs on darwin", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		if (process.platform !== "darwin") return;
		expect(isSensitivePath(path.join(tempHome, "Library", "LaunchAgents", "evil.plist"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, "Library", "LaunchDaemons", "x.plist"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, "Library", "Preferences", "com.apple.x.plist"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, "Library", "Keychains"))).toBe(true);
		expect(isSensitivePath(path.join(tempHome, "Library", "Developer", "Xcode"))).toBe(false);
	});

	it("treats the home root itself as allowed (export target guard rejects it separately)", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		expect(isSensitivePath(tempHome)).toBe(false);
	});

	it("rejects paths outside home only when inside a sensitive root (e.g. another home)", async () => {
		const { isSensitivePath } = await loadSensitivePaths();
		const other = path.join(tempHome, "..", "other-user-home");
		expect(isSensitivePath(path.join(other, ".ssh", "id_rsa"))).toBe(false);
	});
});
