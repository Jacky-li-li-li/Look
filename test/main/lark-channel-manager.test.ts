// ============================================================
// LarkChannelManager lifecycle tests
// ============================================================

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	return {
		lookDir: fs.mkdtempSync(path.join(os.tmpdir(), "look-lark-channel-")),
		sentEvents: [] as Array<{ channel: string; event: unknown }>,
	};
});

vi.mock("../../src/main/shared/look-storage.js", () => ({
	getLookDir: () => mocks.lookDir,
}));

vi.mock("electron", () => ({
	BrowserWindow: vi.fn().mockImplementation(() => ({
		isDestroyed: () => false,
		webContents: {
			send: vi.fn().mockImplementation((channel: string, event: unknown) => {
				mocks.sentEvents.push({ channel, event });
			}),
		},
	})),
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (secret: string) => Buffer.from(`enc:${secret}`),
		decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
	},
}));

const larkMocks = vi.hoisted(() => {
	let wsStarted = false;
	let eventDispatcher: unknown = null;
	const wsCallbacks: { onReady?: () => void; onError?: (err: Error) => void } = {};

	const mockWSClient = vi.fn().mockImplementation((params: any) => {
		wsCallbacks.onReady = params.onReady;
		wsCallbacks.onError = params.onError;
		return {
			start: vi.fn().mockImplementation(async ({ eventDispatcher: ed }: { eventDispatcher: unknown }) => {
				eventDispatcher = ed;
				wsStarted = true;
				params.onReady?.();
			}),
			close: vi.fn().mockImplementation(() => {
				wsStarted = false;
			}),
		};
	});

	const mockClient = vi.fn().mockImplementation(() => ({
		im: {
			v1: {
				message: {
					create: vi.fn().mockResolvedValue({}),
				},
			},
		},
	}));

	const mockEventDispatcher = vi.fn().mockImplementation(() => ({
		register: vi.fn().mockImplementation((handles: unknown) => ({ handles })),
	}));

	return {
		AppType: { SelfBuild: 0 },
		Domain: { Feishu: 0, Lark: 1 },
		LoggerLevel: { info: 3 },
		Client: mockClient,
		WSClient: mockWSClient,
		EventDispatcher: mockEventDispatcher,
		registerApp: vi.fn(),
		get wsStarted() {
			return wsStarted;
		},
		set wsStarted(value: boolean) {
			wsStarted = value;
		},
		get eventDispatcher() {
			return eventDispatcher;
		},
		set eventDispatcher(value: unknown) {
			eventDispatcher = value;
		},
		wsCallbacks,
	};
});

vi.mock("@larksuiteoapi/node-sdk", () => ({
	AppType: larkMocks.AppType,
	Domain: larkMocks.Domain,
	LoggerLevel: larkMocks.LoggerLevel,
	Client: larkMocks.Client,
	WSClient: larkMocks.WSClient,
	EventDispatcher: larkMocks.EventDispatcher,
	registerApp: larkMocks.registerApp,
}));

import { BrowserWindow } from "electron";
import { LarkChannelManager } from "../../src/main/im/lark-channel-manager.js";

function createMainWindow(): BrowserWindow {
	return new BrowserWindow({} as any);
}

function clearStorage(): void {
	const channelsPath = join(mocks.lookDir, "im-channels.json");
	if (existsSync(channelsPath)) {
		rmSync(channelsPath);
	}
}

function readChannels(): unknown {
	const channelsPath = join(mocks.lookDir, "im-channels.json");
	return JSON.parse(readFileSync(channelsPath, "utf8"));
}

describe("LarkChannelManager", () => {
	beforeEach(() => {
		clearStorage();
		mocks.sentEvents.length = 0;
		larkMocks.wsStarted = false;
		larkMocks.eventDispatcher = null;
		larkMocks.Client.mockClear();
		larkMocks.WSClient.mockClear();
		larkMocks.EventDispatcher.mockClear();
		larkMocks.registerApp.mockClear();
	});

	afterEach(() => {
		clearStorage();
	});

	it("auto-connects a saved channel on initialize", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		// Seed storage with an enabled Feishu channel.
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_saved",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Saved",
				enabled: true,
				createdAt: Date.now(),
			},
		];
		const fs = require("node:fs");
		fs.writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));

		await manager.initialize();

		expect(larkMocks.WSClient).toHaveBeenCalledTimes(1);
		expect(larkMocks.wsStarted).toBe(true);
		expect(manager.getChannels()[0].connected).toBe(true);
	});

	it("does not delete saved channels on dispose (app quit)", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_saved",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Saved",
				enabled: true,
				createdAt: Date.now(),
			},
		];
		const fs = require("node:fs");
		fs.writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));

		await manager.initialize();
		await manager.dispose();

		expect(larkMocks.wsStarted).toBe(false);
		expect(readChannels()).toEqual(channels);
	});

	it("disconnect disables only the connected channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_connected",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Connected",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_other",
				appSecretEncrypted: Buffer.from("enc:other").toString("base64"),
				name: "Other",
				enabled: true,
				createdAt: Date.now(),
			},
		];
		const fs = require("node:fs");
		fs.writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));

		await manager.initialize();
		await manager.disconnect("feishu", "cli_connected");

		const remaining = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(remaining).toHaveLength(2);
		expect(remaining.find((c) => c.appId === "cli_connected")?.enabled).toBe(false);
		expect(remaining.find((c) => c.appId === "cli_other")?.enabled).toBe(true);
	});

	it("removeChannel deletes the specified channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_remove",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Remove",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_keep",
				appSecretEncrypted: Buffer.from("enc:keep").toString("base64"),
				name: "Keep",
				enabled: true,
				createdAt: Date.now(),
			},
		];
		const fs = require("node:fs");
		fs.writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));

		await manager.removeChannel("feishu", "cli_remove");

		const remaining = readChannels() as Array<{ appId: string }>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0].appId).toBe("cli_keep");
	});

	it("reconnect connects a saved disabled channel and re-enables it", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const channels = [
			{
				provider: "feishu" as const,
				appId: "cli_reconnect",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Reconnect",
				enabled: false,
				tenantBrand: "lark" as const,
				createdAt: Date.now(),
			},
		];
		const fs = require("node:fs");
		fs.writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));

		await manager.reconnect("feishu", "cli_reconnect");

		expect(larkMocks.WSClient).toHaveBeenCalledTimes(1);
		expect(larkMocks.wsStarted).toBe(true);
		expect(larkMocks.Client.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);

		const updated = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(updated[0].enabled).toBe(true);
	});

	it("prevents duplicate WebSocket clients when connect is called twice", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_first", appSecret: "secret" });
		const firstClose = larkMocks.WSClient.mock.results[0].value.close;
		await manager.connect({ appId: "cli_second", appSecret: "secret" });

		expect(larkMocks.WSClient).toHaveBeenCalledTimes(2);
		// The first WebSocket client should have been closed before creating the
		// second one.
		expect(firstClose).toHaveBeenCalled();
		expect(larkMocks.wsStarted).toBe(true);
	});

	it("uses Lark domain when tenantBrand is lark", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_lark", appSecret: "secret", tenantBrand: "lark" });

		const calls = larkMocks.Client.mock.calls;
		expect(calls[0][0].domain).toBe(larkMocks.Domain.Lark);
		expect(larkMocks.WSClient.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);
	});

	it("uses Feishu domain by default", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_feishu", appSecret: "secret" });

		expect(larkMocks.Client.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
		expect(larkMocks.WSClient.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
	});

	it("manually connects and stores a Feishu channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());

		await manager.connectManual({ appId: " cli_manual ", appSecret: " secret " });

		expect(larkMocks.Client.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
		expect(larkMocks.WSClient.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
		const channels = readChannels() as Array<{
			appId: string;
			enabled: boolean;
			appSecretEncrypted?: string;
			appSecretPlain?: string;
		}>;
		expect(channels).toHaveLength(1);
		expect(channels[0].appId).toBe("cli_manual");
		expect(channels[0].enabled).toBe(true);
		expect(channels[0].appSecretEncrypted).toBe(Buffer.from("enc:secret").toString("base64"));
		expect(channels[0].appSecretPlain).toBeUndefined();
	});

	it("stores tenant brand from registerApp and passes it to connect", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		larkMocks.registerApp.mockResolvedValueOnce({
			client_id: "cli_reg",
			client_secret: "secret",
			user_info: { tenant_brand: "lark" },
		});

		await manager.startRegistration({ appName: "Test" });
		// Allow async run() to complete.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const channels = readChannels() as Array<{ appId: string; tenantBrand?: string }>;
		expect(channels).toHaveLength(1);
		expect(channels[0].appId).toBe("cli_reg");
		expect(channels[0].tenantBrand).toBe("lark");
		expect(larkMocks.Client.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);
	});

	it("does not overwrite the QR phase with SDK polling updates", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		larkMocks.registerApp.mockImplementationOnce(async (options: any) => {
			options.onQRCodeReady({ url: "https://example.com/qr", expireIn: 600 });
			options.onStatusChange?.({ status: "polling" });
			return {
				client_id: "cli_qr",
				client_secret: "secret",
				user_info: { tenant_brand: "feishu" },
			};
		});

		await manager.startRegistration({ appName: "Test" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		const registrationEvents = mocks.sentEvents
			.map((entry) => entry.event as { type?: string; phase?: string; url?: string })
			.filter((event) => event.type === "im:registration-update");
		expect(registrationEvents).toContainEqual(
			expect.objectContaining({
				phase: "qr",
				url: "https://example.com/qr",
			}),
		);
		expect(registrationEvents).not.toContainEqual(expect.objectContaining({ phase: "polling" }));
	});
});
