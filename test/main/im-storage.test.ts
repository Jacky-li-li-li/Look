// ============================================================
// IM channel persistence tests
// ============================================================

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	return {
		lookDir: fs.mkdtempSync(path.join(os.tmpdir(), "look-im-storage-")),
	};
});

vi.mock("electron", () => ({
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (secret: string) => Buffer.from(`enc:${secret}`),
		decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
	},
}));

vi.mock("../../src/main/shared/look-storage.js", () => ({
	getLookDir: () => mocks.lookDir,
}));

import { decryptSecret, encryptSecret, loadChannels, saveChannels } from "../../src/main/im/im-storage.js";

describe("im-storage", () => {
	const channelsPath = join(mocks.lookDir, "im-channels.json");

	beforeEach(() => {
		if (existsSync(channelsPath)) {
			rmSync(channelsPath);
		}
	});

	afterEach(() => {
		if (existsSync(channelsPath)) {
			rmSync(channelsPath);
		}
	});

	it("returns an empty array when channels file does not exist", () => {
		expect(loadChannels()).toEqual([]);
	});

	it("round-trips channels through save and load", () => {
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_xxx",
				appSecretEncrypted: "encrypted-secret",
				name: "Test Bot",
				enabled: true,
				createdAt: Date.now(),
			},
		];
		saveChannels(channels);
		const loaded = loadChannels();
		expect(loaded).toEqual(channels);
		expect(existsSync(channelsPath)).toBe(true);
	});

	it("encrypts and decrypts secrets", () => {
		const secret = "super-secret";
		const encrypted = encryptSecret(secret);
		expect("encrypted" in encrypted).toBe(true);

		const channel = {
			provider: "feishu" as const,
			appId: "cli_xxx",
			appSecretEncrypted: encrypted.encrypted,
			enabled: true,
			createdAt: 0,
		};
		expect(decryptSecret(channel)).toBe(secret);
	});

	it("falls back to plain storage when encryption fails", () => {
		const secret = "plain-secret";
		const channel = {
			provider: "feishu" as const,
			appId: "cli_xxx",
			appSecretPlain: secret,
			enabled: true,
			createdAt: 0,
		};
		expect(decryptSecret(channel)).toBe(secret);
	});
});
