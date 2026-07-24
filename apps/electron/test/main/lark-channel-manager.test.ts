// ============================================================
// LarkChannelManager lifecycle and bridge tests
// ============================================================

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
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

vi.mock("@look/shared/look-storage", () => ({
	getLookDir: () => mocks.lookDir,
}));

vi.mock("electron", () => ({
	BrowserWindow: vi.fn().mockImplementation(() => ({
		isDestroyed: () => false,
		webContents: {
			isDestroyed: () => false,
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
	const makeClient = vi.fn().mockImplementation((params: Record<string, unknown>) => ({
		params,
		auth: {
			tenantAccessToken: {
				internal: vi.fn().mockResolvedValue({ code: 0 }),
			},
		},
		im: {
			v1: {
				message: {
					create: vi.fn().mockResolvedValue({ data: { message_id: "sent_message" } }),
				},
				chat: {
					// Tests override per scenario; default behaves like a bot that
					// cannot read the chat (Feishu rejects with an error).
					get: vi.fn().mockRejectedValue(new Error("chat not found")),
				},
			},
		},
	}));

	const channels: Array<Record<string, unknown>> = [];
	const createLarkChannel = vi.fn().mockImplementation((params: Record<string, unknown>) => {
		const handlers: Record<string, (...args: unknown[]) => unknown> = {};
		const streamControllers: Array<Record<string, unknown>> = [];
		const channel = {
			params,
			rawClient: makeClient(params),
			botIdentity: { openId: "bot_open_id", name: "Look Bot" },
			streamControllers,
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn().mockResolvedValue(undefined),
			on: vi
				.fn()
				.mockImplementation(
					(
						nameOrHandlers: string | Record<string, (...args: unknown[]) => unknown>,
						handler?: (...args: unknown[]) => unknown,
					) => {
						if (typeof nameOrHandlers === "string") {
							handlers[nameOrHandlers] = handler;
							return () => {
								if (handlers[nameOrHandlers] === handler) delete handlers[nameOrHandlers];
							};
						}
						for (const [name, fn] of Object.entries(nameOrHandlers)) {
							if (fn) handlers[name] = fn;
						}
						return () => {
							for (const [name, fn] of Object.entries(nameOrHandlers)) {
								if (handlers[name] === fn) delete handlers[name];
							}
						};
					},
				),
			send: vi.fn().mockResolvedValue({ messageId: "sent_message" }),
			stream: vi.fn().mockImplementation(async (_to: string, input: Record<string, unknown>) => {
				const controller = {
					messageId: "stream_message",
					current: input.card.initial,
					update: vi.fn().mockImplementation(async (next: object) => {
						controller.current = next;
					}),
				};
				streamControllers.push(controller);
				await input.card.producer(controller);
				return { messageId: "stream_message" };
			}),
			emit: async (name: string, payload?: unknown) => {
				await handlers[name]?.(payload);
			},
		};
		channels.push(channel);
		return channel;
	});

	return {
		AppType: { SelfBuild: 0 },
		Domain: { Feishu: 0, Lark: 1 },
		LoggerLevel: { info: 3 },
		Client: makeClient,
		createLarkChannel,
		registerApp: vi.fn(),
		channels,
	};
});

vi.mock("@larksuiteoapi/node-sdk", () => ({
	AppType: larkMocks.AppType,
	Domain: larkMocks.Domain,
	LoggerLevel: larkMocks.LoggerLevel,
	Client: larkMocks.Client,
	createLarkChannel: larkMocks.createLarkChannel,
	registerApp: larkMocks.registerApp,
}));

import type { RegisterAppOptions } from "@larksuiteoapi/node-sdk";
import type { MainToRendererEvent } from "@shared/types.js";
import { BrowserWindow } from "electron";
import type { IImAgentHost } from "../../src/main/core/contracts.js";
import { LarkBridgeService } from "../../src/main/im/lark-bridge-service.js";
import { LarkChannelManager } from "../../src/main/im/lark-channel-manager.js";

function createMainWindow(): BrowserWindow {
	return new BrowserWindow({} as unknown as Electron.BrowserWindowConstructorOptions);
}

function clearStorage(): void {
	for (const file of ["im-channels.json", "im-bindings.json"]) {
		const filePath = join(mocks.lookDir, file);
		if (existsSync(filePath)) {
			rmSync(filePath);
		}
	}
}

function writeChannels(channels: unknown): void {
	writeFileSync(join(mocks.lookDir, "im-channels.json"), JSON.stringify(channels));
}

function writeBindings(bindings: unknown): void {
	writeFileSync(join(mocks.lookDir, "im-bindings.json"), JSON.stringify(bindings));
}

function readChannels(): unknown {
	return JSON.parse(readFileSync(join(mocks.lookDir, "im-channels.json"), "utf8"));
}

function sampleMessage(content = "hello", chatId = "chat_1"): NormalizedMessage {
	return {
		messageId: `msg_${Math.random().toString(36).slice(2)}`,
		chatId,
		chatType: "p2p",
		senderId: "user_open_id",
		senderName: "User",
		content,
		rawContentType: "text",
		resources: [],
		mentions: [],
		mentionAll: false,
		mentionedBot: false,
		createTime: Date.now(),
	};
}

function createRuntimeMock(
	customSendMessage?: (sessionId: string, emit: (event: MainToRendererEvent) => void) => void | Promise<void>,
) {
	const callbacks: Array<(event: MainToRendererEvent) => void> = [];
	const projects = [
		{ id: "project_1", name: "Project", cwd: "/tmp/project", createdAt: 0, valid: true },
		{ id: "project_2", name: "Second", cwd: "/tmp/second", createdAt: 1, valid: true },
		{ id: "project_bad", name: "Missing", cwd: "/tmp/missing", createdAt: 2, valid: false },
	];
	let activeProject = projects[0];
	let sessionIndex = 0;
	const runtime = {
		getActiveProject: vi.fn(() => activeProject),
		listProjects: vi.fn(() => projects),
		createProject: vi.fn().mockImplementation(async (cwd: string, name?: string) => {
			const existing = projects.find((project) => project.cwd === cwd);
			if (existing) {
				activeProject = existing;
				return { project: existing, isDuplicate: true };
			}
			const project = {
				id: "project_new",
				name: name ?? "new",
				cwd,
				createdAt: 3,
				valid: true,
			};
			projects.push(project);
			activeProject = project;
			return { project, isDuplicate: false };
		}),
		createAgent: vi.fn().mockImplementation(async (opts?: { projectId?: string }) => {
			if (opts?.projectId) {
				activeProject = projects.find((project) => project.id === opts.projectId) ?? activeProject;
			}
			sessionIndex += 1;
			return `session_${sessionIndex}`;
		}),
		sendMessage: vi.fn().mockImplementation(async (sessionId: string) => {
			if (customSendMessage) {
				await customSendMessage(sessionId, (event) => {
					for (const cb of callbacks) cb(event);
				});
				return;
			}
			for (const cb of callbacks) {
				cb({
					type: "session:ui-event",
					sessionId,
					events: [
						{ type: "assistant_text_delta", contentIndex: 0, delta: "reply", timestamp: Date.now() },
						{ type: "assistant_text_end", contentIndex: 0, text: "reply", timestamp: Date.now() },
					],
				});
				cb({
					type: "session:snapshot",
					sessionId,
					reason: "agent_end",
					leafId: null,
					entries: [],
					runtime: {
						thinkingLevel: "off",
						isStreaming: false,
						isRetrying: false,
						isCompacting: false,
						retryAttempt: 0,
						steering: [],
						followUp: [],
						stats: {} as Record<string, never>,
					},
				});
			}
		}),
		onEvent: vi.fn().mockImplementation((cb: (event: MainToRendererEvent) => void) => {
			callbacks.push(cb);
			return () => {
				const index = callbacks.indexOf(cb);
				if (index >= 0) callbacks.splice(index, 1);
			};
		}),
		getAgentInfo: vi.fn(() => ({ name: "Session", messageCount: 0 })),
		abortAgent: vi.fn().mockResolvedValue(undefined),
	};
	return runtime;
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

async function nextTick(): Promise<void> {
	await Promise.resolve();
}

function findCollapsiblePanels(card: Record<string, unknown>): Array<Record<string, unknown>> {
	const found: Array<Record<string, unknown>> = [];
	const visit = (node: Record<string, unknown> | null) => {
		if (!node || typeof node !== "object") return;
		if (node.tag === "collapsible_panel") found.push(node);
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
			} else {
				visit(value);
			}
		}
	};
	visit(card);
	return found;
}

describe("LarkChannelManager", () => {
	beforeEach(() => {
		clearStorage();
		mocks.sentEvents.length = 0;
		larkMocks.channels.length = 0;
		larkMocks.Client.mockClear();
		larkMocks.createLarkChannel.mockClear();
		larkMocks.registerApp.mockReset();
	});

	afterEach(() => {
		clearStorage();
	});

	it("auto-connects a saved channel on initialize", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_saved",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Saved",
				enabled: true,
				createdAt: Date.now(),
			},
		]);

		await manager.initialize();

		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(1);
		expect(larkMocks.channels[0].connect).toHaveBeenCalledTimes(1);
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
		writeChannels(channels);

		await manager.initialize();
		await manager.dispose();

		expect(larkMocks.channels[0].disconnect).toHaveBeenCalledTimes(1);
		expect(readChannels()).toEqual(channels);
	});

	it("disconnect disables only the connected channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
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
		]);

		await manager.initialize();
		await manager.disconnect("feishu", "cli_connected");

		const remaining = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(remaining).toHaveLength(2);
		expect(remaining.find((c) => c.appId === "cli_connected")?.enabled).toBe(false);
		expect(remaining.find((c) => c.appId === "cli_other")?.enabled).toBe(true);
	});

	it("removeChannel deletes the specified channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
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
		]);

		await manager.removeChannel("feishu", "cli_remove");

		const remaining = readChannels() as Array<{ appId: string }>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0].appId).toBe("cli_keep");
	});

	it("reconnect connects a saved disabled channel and re-enables it", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_reconnect",
				appSecretEncrypted: Buffer.from("enc:secret").toString("base64"),
				name: "Reconnect",
				enabled: false,
				tenantBrand: "lark" as const,
				createdAt: Date.now(),
			},
		]);

		await manager.reconnect("feishu", "cli_reconnect");

		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(1);
		expect(larkMocks.createLarkChannel.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);
		expect(larkMocks.channels[0].connect).toHaveBeenCalledTimes(1);

		const updated = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(updated[0].enabled).toBe(true);
	});

	it("reconnects the same appId cleanly and keeps different channels connected at the same time", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_first", appSecret: "secret" });
		// Same appId again: the old connection is closed before the new one —
		// never two clients for one appId.
		await manager.connect({ appId: "cli_first", appSecret: "secret" });
		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(2);
		expect(larkMocks.channels[0].disconnect).toHaveBeenCalledTimes(1);
		expect(manager.getConnectedAppIds()).toEqual(["cli_first"]);

		// A different appId gets its own connection; the first one stays alive.
		await manager.connect({ appId: "cli_second", appSecret: "secret" });
		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(3);
		expect(larkMocks.channels[1].disconnect).not.toHaveBeenCalled();
		expect(larkMocks.channels[2].connect).toHaveBeenCalledTimes(1);
		expect(manager.getConnectedAppIds().sort()).toEqual(["cli_first", "cli_second"]);
	});

	it("uses Lark domain when tenantBrand is lark", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_lark", appSecret: "secret", tenantBrand: "lark" });

		expect(larkMocks.createLarkChannel.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);
	});

	it("uses Feishu domain by default", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_feishu", appSecret: "secret" });

		expect(larkMocks.createLarkChannel.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
	});

	it("sends an interactive card when card payload is provided", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_card", appSecret: "secret" });

		const card = {
			header: { title: { tag: "plain_text", content: "Test card" }, template: "green" },
			elements: [{ tag: "markdown", content: "Hello" }],
		};
		const result = await manager.sendTestMessage({
			receiveIdType: "chat_id",
			receiveId: "chat-1",
			text: "fallback text",
			card,
		});

		expect(result.success).toBe(true);
		const client = manager.getRawClient() as ReturnType<typeof larkMocks.Client>;
		const call = client.im.v1.message.create.mock.calls[0][0];
		expect(call.data.msg_type).toBe("interactive");
		expect(call.data.receive_id).toBe("chat-1");
		// Feishu interactive messages expect the card object directly as content,
		// not wrapped in { card: ... }.
		expect(JSON.parse(call.data.content)).toEqual(card);
	});

	it("manually connects and stores a Feishu channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());

		await manager.connectManual({ appId: " cli_manual ", appSecret: " secret " });

		expect(larkMocks.createLarkChannel.mock.calls[0][0].domain).toBe(larkMocks.Domain.Feishu);
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
		await flushAsync();

		const channels = readChannels() as Array<{ appId: string; tenantBrand?: string }>;
		expect(channels).toHaveLength(1);
		expect(channels[0].appId).toBe("cli_reg");
		expect(channels[0].tenantBrand).toBe("lark");
		expect(larkMocks.createLarkChannel.mock.calls[0][0].domain).toBe(larkMocks.Domain.Lark);
	});

	it("does not overwrite the QR phase with SDK polling updates", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		larkMocks.registerApp.mockImplementationOnce(async (options: RegisterAppOptions) => {
			options.onQRCodeReady({ url: "https://example.com/qr", expireIn: 600 });
			options.onStatusChange?.({ status: "polling" });
			return {
				client_id: "cli_qr",
				client_secret: "secret",
				user_info: { tenant_brand: "feishu" },
			};
		});

		await manager.startRegistration({ appName: "Test" });
		await flushAsync();

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

	it("initializes the bridge after manual connect and creates an agent from inbound messages", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);
		manager.onConnectionClosed = () => bridge.detachChannel();

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("hello agent"));
		await flushAsync();

		expect(bridge.getStatus().status).toBe("running");
		expect(runtime.createAgent).toHaveBeenCalledTimes(1);
		expect(runtime.createAgent).toHaveBeenCalledWith({ projectId: "project_1", imProvider: "feishu" });
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_1", "hello agent");
		expect(larkMocks.channels[0].stream).toHaveBeenCalledTimes(1);
	});

	it("recovers a persisted final reply when a provider omits text delta events", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock(async (sessionId, emit) => {
			emit({
				type: "session:snapshot",
				sessionId,
				reason: "agent_end",
				leafId: null,
				entries: [
					{ type: "message", message: { role: "user", content: "hello agent" } },
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "persisted final reply" }],
						},
					},
				] as unknown as Extract<MainToRendererEvent, { type: "session:snapshot" }>["entries"],
				runtime: {
					thinkingLevel: "off",
					isStreaming: false,
					isRetrying: false,
					isCompacting: false,
					retryAttempt: 0,
					steering: [],
					followUp: [],
					stats: {} as never,
				},
			});
		});
		manager.onConnectionReady = () => bridge.init(runtime as never, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("hello agent"));
		await flushAsync();

		const controller = larkMocks.channels[0].streamControllers[0];
		expect(JSON.stringify(controller.current)).toContain("persisted final reply");
		expect(JSON.stringify(controller.current)).not.toContain("Agent 未返回文本回复");
	});

	it("reuses the /new session when the next chat message arrives before binding creation finishes", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		let releaseCreateAgent!: () => void;
		const originalCreateAgent = runtime.createAgent;
		runtime.createAgent = vi.fn().mockImplementation(async (opts?: { projectId?: string }) => {
			await new Promise<void>((resolve) => {
				releaseCreateAgent = resolve;
			});
			return originalCreateAgent(opts);
		});
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		const newCommand = larkMocks.channels[0].emit("message", sampleMessage("/new"));
		await nextTick();
		const followUp = larkMocks.channels[0].emit("message", sampleMessage("use the new session"));
		await nextTick();
		releaseCreateAgent();
		await Promise.all([newCommand, followUp]);
		await flushAsync();

		expect(runtime.createAgent).toHaveBeenCalledTimes(1);
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_1", "use the new session");
		expect(bridge.getBindings()).toEqual([
			expect.objectContaining({
				chatId: "chat_1",
				sessionId: "session_1",
			}),
		]);
	});

	it("streams tool panels expanded while running and collapsed after completion", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock(async (sessionId, emit) => {
			emit({
				type: "session:ui-event",
				sessionId,
				events: [
					{
						type: "tool_exec_start",
						toolCallId: "tool_1",
						toolName: "bash",
						args: { command: "pwd" },
						timestamp: Date.now(),
					},
				],
			});
			await flushAsync();
			emit({
				type: "session:ui-event",
				sessionId,
				events: [
					{
						type: "tool_exec_end",
						toolCallId: "tool_1",
						toolName: "bash",
						result: "/tmp/project",
						isError: false,
						timestamp: Date.now(),
					},
					{ type: "assistant_text_delta", contentIndex: 0, delta: "done", timestamp: Date.now() },
					{ type: "assistant_text_end", contentIndex: 0, text: "done", timestamp: Date.now() },
					{ type: "run_status", status: "idle", timestamp: Date.now() },
				],
			});
			emit({
				type: "session:snapshot",
				sessionId,
				reason: "agent_end",
				leafId: null,
				entries: [],
				runtime: {
					thinkingLevel: "off",
					isStreaming: false,
					isRetrying: false,
					isCompacting: false,
					retryAttempt: 0,
					steering: [],
					followUp: [],
					stats: {} as Record<string, never>,
				},
			});
		});
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("run pwd"));
		await flushAsync();

		const controller = larkMocks.channels[0].streamControllers[0];
		const updatedCards = (controller.update.mock.calls as Array<Array<Record<string, unknown>>>).map(
			(call) => call[0],
		);
		const panels = updatedCards.flatMap(findCollapsiblePanels);
		expect(
			panels.some((panel) => panel.header?.title?.content === "工具 · bash · 运行中" && panel.expanded === true),
		).toBe(true);
		expect(
			panels.some((panel) => panel.header?.title?.content === "工具 · bash · 完成" && panel.expanded === false),
		).toBe(true);
		expect(JSON.stringify(updatedCards.at(-1))).toContain("done");
	});

	it("refreshes the bridge channel after reconnect before streaming replies", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);
		manager.onConnectionClosed = () => bridge.detachChannel();

		await manager.connectManual({ appId: "cli_reconnect", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("first"));
		await flushAsync();

		await manager.reconnect("feishu", "cli_reconnect");
		await larkMocks.channels[1].emit("message", sampleMessage("second"));
		await flushAsync();

		expect(larkMocks.channels[0].stream).toHaveBeenCalledTimes(1);
		expect(larkMocks.channels[1].stream).toHaveBeenCalledTimes(1);
		expect(runtime.createAgent).toHaveBeenCalledTimes(1);
		expect(runtime.sendMessage).toHaveBeenLastCalledWith("session_1", "second");
	});

	it("lists projects with the /project command", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("/project"));

		const sentText = larkMocks.channels[0].send.mock.calls.at(-1)?.[1]?.text;
		expect(sentText).toContain("📁 项目列表");
		expect(sentText).toContain("1. Project");
		expect(sentText).toContain("2. Second");
		expect(sentText).toContain("3. Missing");
		expect(runtime.createAgent).not.toHaveBeenCalled();
	});

	it("sends /help as a renderable Feishu card", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("/help"));

		const sent = larkMocks.channels[0].send.mock.calls.at(-1)?.[1];
		expect(sent?.text).toBeUndefined();
		expect(sent?.card).toEqual(
			expect.objectContaining({
				header: expect.objectContaining({
					title: expect.objectContaining({ content: "Look Agent 飞书 Bot" }),
				}),
				elements: expect.arrayContaining([
					expect.objectContaining({
						tag: "markdown",
						content: expect.stringContaining("/project"),
					}),
				]),
			}),
		);
	});

	it("switches the chat binding to a selected project", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("/project 2"));
		await larkMocks.channels[0].emit("message", sampleMessage("hello second"));

		expect(runtime.createAgent).toHaveBeenCalledWith({ projectId: "project_2", imProvider: "feishu" });
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_1", "hello second");
		const sentText = larkMocks.channels[0].send.mock.calls[0]?.[1]?.text;
		expect(sentText).toContain("已切换到项目");
		expect(sentText).toContain("Second");
	});

	it("creates a project with /new project and binds the chat to it", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage('/new project "/tmp/new app" "New App"'));
		await larkMocks.channels[0].emit("message", sampleMessage("hello new"));

		expect(runtime.createProject).toHaveBeenCalledWith("/tmp/new app", "New App");
		expect(runtime.createAgent).toHaveBeenCalledWith({ projectId: "project_new", imProvider: "feishu" });
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_1", "hello new");
		const sentText = larkMocks.channels[0].send.mock.calls[0]?.[1]?.text;
		expect(sentText).toContain("已新建项目并切换");
		expect(sentText).toContain("New App");
	});

	it("keeps other channels enabled when a manual connect succeeds", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_old",
				appSecretEncrypted: Buffer.from("enc:old").toString("base64"),
				name: "Old",
				enabled: true,
				createdAt: Date.now(),
			},
		]);

		await manager.connectManual({ appId: "cli_new", appSecret: "secret" });

		const channels = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(channels.find((c) => c.appId === "cli_new")?.enabled).toBe(true);
		expect(channels.find((c) => c.appId === "cli_old")?.enabled).toBe(true);
	});

	it("reconnect keeps the other saved channels' enabled state", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_a",
				appSecretEncrypted: Buffer.from("enc:a").toString("base64"),
				name: "A",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_b",
				appSecretEncrypted: Buffer.from("enc:b").toString("base64"),
				name: "B",
				enabled: false,
				createdAt: Date.now(),
			},
		]);

		await manager.reconnect("feishu", "cli_b");

		const channels = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(channels.find((c) => c.appId === "cli_a")?.enabled).toBe(true);
		expect(channels.find((c) => c.appId === "cli_b")?.enabled).toBe(true);
	});

	it("tracks connection status per channel when multiple bots connect", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_live",
				appSecretEncrypted: Buffer.from("enc:live").toString("base64"),
				name: "Live",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_idle",
				appSecretEncrypted: Buffer.from("enc:idle").toString("base64"),
				name: "Idle",
				enabled: false,
				createdAt: Date.now(),
			},
		]);

		await manager.reconnect("feishu", "cli_live");

		let items = manager.getChannels();
		expect(items.find((c) => c.appId === "cli_live")).toMatchObject({ status: "connected", connected: true });
		expect(items.find((c) => c.appId === "cli_idle")).toMatchObject({ status: "disconnected", connected: false });

		// The second channel connects independently; both stay online.
		await manager.reconnect("feishu", "cli_idle");

		items = manager.getChannels();
		expect(items.find((c) => c.appId === "cli_live")).toMatchObject({ status: "connected", connected: true });
		expect(items.find((c) => c.appId === "cli_idle")).toMatchObject({ status: "connected", connected: true });
	});

	it("sends to a chat through an ad-hoc client for a channel that is not connected", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_sender",
				appSecretEncrypted: Buffer.from("enc:sender").toString("base64"),
				name: "Sender",
				enabled: false,
				tenantBrand: "lark" as const,
				createdAt: Date.now(),
			},
		]);

		const result = await manager.sendToChat("cli_sender", "oc_chat", { text: "hello" });

		expect(result.success).toBe(true);
		// A new ad-hoc Client was constructed from the stored credentials.
		const clientCalls = (larkMocks.Client.mock.calls as Array<Array<Record<string, unknown>>>).filter(
			(call) => (call[0] as Record<string, unknown>)?.appId === "cli_sender",
		);
		expect(clientCalls.length).toBeGreaterThan(0);
		expect(clientCalls[0][0].domain).toBe(larkMocks.Domain.Lark);
		const adHocClient = manager.getClient("cli_sender") as ReturnType<typeof larkMocks.Client>;
		expect(adHocClient.im.v1.message.create).toHaveBeenCalledTimes(1);
	});

	it("sendToChat fails cleanly for an unknown channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const result = await manager.sendToChat("cli_missing", "oc_chat", { text: "hello" });
		expect(result.success).toBe(false);
		expect(result.error).toContain("not available");
	});

	it("captures chat metadata on new bindings and resolves the p2p conversation for a channel", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_bot", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("hello agent"));
		await flushAsync();

		const binding = bridge.getBindings()[0];
		expect(binding).toMatchObject({
			chatId: "chat_1",
			appId: "cli_bot",
			chatType: "p2p",
			senderOpenId: "user_open_id",
			peerName: "User",
		});

		const resolved = await bridge.resolveP2pBinding("cli_bot");
		expect(resolved?.chatId).toBe("chat_1");
		// A different channel has no conversation yet.
		expect(await bridge.resolveP2pBinding("cli_other")).toBeNull();
	});

	it("keeps chat metadata when the session is recreated with /new", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_bot", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("hello agent"));
		await flushAsync();
		await larkMocks.channels[0].emit("message", sampleMessage("/new"));
		await flushAsync();

		expect(runtime.createAgent).toHaveBeenCalledTimes(2);
		const binding = bridge.getBindings()[0];
		expect(binding.sessionId).toBe("session_2");
		expect(binding).toMatchObject({ appId: "cli_bot", chatType: "p2p", senderOpenId: "user_open_id" });
	});

	it("keeps separate p2p bindings per bot with concurrent connections", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);
		manager.onConnectionClosed = (appId) => bridge.detachChannel(appId);

		// Bot A goes live first and the user messages it.
		await manager.connectManual({ appId: "cli_bot_a", appSecret: "secret_a", name: "Bot A" });
		await larkMocks.channels[0].emit("message", sampleMessage("hi bot a", "oc_p2p_a"));
		await flushAsync();

		// Bot B goes live as well (both stay connected), user messages it.
		await manager.connectManual({ appId: "cli_bot_b", appSecret: "secret_b", name: "Bot B" });
		await larkMocks.channels[1].emit("message", sampleMessage("hi bot b", "oc_p2p_b"));
		await flushAsync();

		const bindings = bridge.getBindings();
		expect(bindings).toHaveLength(2);
		expect(bindings.find((b) => b.chatId === "oc_p2p_a")).toMatchObject({ appId: "cli_bot_a", chatType: "p2p" });
		expect(bindings.find((b) => b.chatId === "oc_p2p_b")).toMatchObject({ appId: "cli_bot_b", chatType: "p2p" });

		// Each channel resolves to its own private conversation only.
		expect((await bridge.resolveP2pBinding("cli_bot_a"))?.chatId).toBe("oc_p2p_a");
		expect((await bridge.resolveP2pBinding("cli_bot_b"))?.chatId).toBe("oc_p2p_b");

		// Both channels stay enabled and connected.
		const channels = readChannels() as Array<{ appId: string; enabled: boolean }>;
		expect(channels.find((c) => c.appId === "cli_bot_a")?.enabled).toBe(true);
		expect(channels.find((c) => c.appId === "cli_bot_b")?.enabled).toBe(true);
		expect(manager.getConnectedAppIds().sort()).toEqual(["cli_bot_a", "cli_bot_b"]);
	});

	it("self-heals a legacy binding only for the bot that can actually read it", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeBindings([
			{ chatId: "oc_legacy", sessionId: "session_x", projectId: "project_1", createdAt: Date.now() },
			{ chatId: "oc_stray", sessionId: "session_y", projectId: "project_1", createdAt: Date.now() },
		]);
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_bot_a", appSecret: "secret_a" });
		// Bot A can read oc_legacy (it is its own p2p chat); it has no access to oc_stray.
		const liveClient = larkMocks.channels[0].rawClient as ReturnType<typeof larkMocks.Client>;
		liveClient.im.v1.chat.get.mockImplementation(async ({ path }: { path: string }) =>
			path.chat_id === "oc_legacy"
				? { code: 0, data: { chat_mode: "p2p", name: "" } }
				: { code: 230002, data: undefined },
		);

		// Probing for A heals the legacy binding and returns it.
		expect((await bridge.resolveP2pBinding("cli_bot_a"))?.chatId).toBe("oc_legacy");
		const healed = bridge.getBindings().find((b) => b.chatId === "oc_legacy");
		expect(healed).toMatchObject({ appId: "cli_bot_a", chatType: "p2p" });
		// oc_stray could not be read: it stays untyped and unclaimed.
		const stray = bridge.getBindings().find((b) => b.chatId === "oc_stray");
		expect(stray?.appId).toBeUndefined();
		expect(stray?.chatType).toBeUndefined();
		// A different bot never resolves these bindings as its own p2p channel.
		expect(await bridge.resolveP2pBinding("cli_bot_b")).toBeNull();
	});

	it("routes sends through per-channel credentials with cached ad-hoc clients", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_alpha",
				appSecretEncrypted: Buffer.from("enc:secret_alpha").toString("base64"),
				name: "Alpha",
				enabled: false,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_beta",
				appSecretEncrypted: Buffer.from("enc:secret_beta").toString("base64"),
				name: "Beta",
				enabled: false,
				tenantBrand: "lark" as const,
				createdAt: Date.now(),
			},
		]);

		expect((await manager.sendToChat("cli_alpha", "oc_1", { text: "from alpha" })).success).toBe(true);
		expect((await manager.sendToChat("cli_beta", "oc_2", { text: "from beta" })).success).toBe(true);

		const clientFor = (appId: string) =>
			(larkMocks.Client.mock.results as Array<Record<string, unknown>>)
				.map((result) => result.value)
				.find((value) => value?.params?.appId === appId);
		const alphaClient = clientFor("cli_alpha");
		const betaClient = clientFor("cli_beta");
		expect(alphaClient).toBeTruthy();
		expect(betaClient).toBeTruthy();
		// Each client was built from its own secret and tenant domain.
		expect(alphaClient.params.appSecret).toBe("secret_alpha");
		expect(betaClient.params.appSecret).toBe("secret_beta");
		expect(betaClient.params.domain).toBe(larkMocks.Domain.Lark);
		// Each message went out through the matching client exactly once.
		expect(alphaClient.im.v1.message.create).toHaveBeenCalledTimes(1);
		expect(betaClient.im.v1.message.create).toHaveBeenCalledTimes(1);
		expect(alphaClient.im.v1.message.create.mock.calls[0][0].data.receive_id).toBe("oc_1");
		expect(betaClient.im.v1.message.create.mock.calls[0][0].data.receive_id).toBe("oc_2");
		// Ad-hoc clients are cached per appId.
		expect(manager.getClient("cli_alpha")).toBe(alphaClient);
	});

	it("connects every enabled channel on initialize", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		writeChannels([
			{
				provider: "feishu" as const,
				appId: "cli_one",
				appSecretEncrypted: Buffer.from("enc:one").toString("base64"),
				name: "One",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_two",
				appSecretEncrypted: Buffer.from("enc:two").toString("base64"),
				name: "Two",
				enabled: true,
				createdAt: Date.now(),
			},
			{
				provider: "feishu" as const,
				appId: "cli_off",
				appSecretEncrypted: Buffer.from("enc:off").toString("base64"),
				name: "Off",
				enabled: false,
				createdAt: Date.now(),
			},
		]);

		await manager.initialize();

		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(2);
		expect(manager.getConnectedAppIds().sort()).toEqual(["cli_one", "cli_two"]);
		const items = manager.getChannels();
		expect(items.find((c) => c.appId === "cli_one")?.connected).toBe(true);
		expect(items.find((c) => c.appId === "cli_two")?.connected).toBe(true);
		expect(items.find((c) => c.appId === "cli_off")?.connected).toBe(false);
	});

	it("keeps other bots online and replying when one bot is disconnected", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);
		manager.onConnectionClosed = (appId) => bridge.detachChannel(appId);

		await manager.connectManual({ appId: "cli_bot_a", appSecret: "secret_a", name: "Bot A" });
		await manager.connectManual({ appId: "cli_bot_b", appSecret: "secret_b", name: "Bot B" });
		await larkMocks.channels[0].emit("message", sampleMessage("hi a", "oc_chat_a"));
		await larkMocks.channels[1].emit("message", sampleMessage("hi b", "oc_chat_b"));
		await flushAsync();
		expect(larkMocks.channels[0].stream).toHaveBeenCalledTimes(1);
		expect(larkMocks.channels[1].stream).toHaveBeenCalledTimes(1);

		await manager.disconnect("feishu", "cli_bot_a");
		expect(manager.getConnectedAppIds()).toEqual(["cli_bot_b"]);
		expect(manager.getChannels().find((c) => c.appId === "cli_bot_a")?.enabled).toBe(false);

		// Bot B still receives and replies through its own channel.
		await larkMocks.channels[1].emit("message", sampleMessage("again b", "oc_chat_b"));
		await flushAsync();
		expect(larkMocks.channels[1].stream).toHaveBeenCalledTimes(2);
		expect(larkMocks.channels[0].stream).toHaveBeenCalledTimes(1);
	});

	it("keeps independent sessions for the same chatId on two different bots", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		const bridge = new LarkBridgeService();
		const runtime = createRuntimeMock();
		manager.onConnectionReady = () => bridge.init(runtime as unknown as IImAgentHost, manager);

		await manager.connectManual({ appId: "cli_bot_a", appSecret: "secret_a", name: "Bot A" });
		await manager.connectManual({ appId: "cli_bot_b", appSecret: "secret_b", name: "Bot B" });
		// 同一个群（同一 chatId）里两个 bot 都在：各自拥有独立会话，回复各走各的连接。
		await larkMocks.channels[0].emit("message", sampleMessage("hello from a", "oc_shared"));
		await larkMocks.channels[1].emit("message", sampleMessage("hello from b", "oc_shared"));
		await flushAsync();

		expect(runtime.createAgent).toHaveBeenCalledTimes(2);
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_1", "hello from a");
		expect(runtime.sendMessage).toHaveBeenCalledWith("session_2", "hello from b");
		expect(larkMocks.channels[0].stream).toHaveBeenCalledTimes(1);
		expect(larkMocks.channels[1].stream).toHaveBeenCalledTimes(1);
		const bindings = bridge.getBindings().filter((b) => b.chatId === "oc_shared");
		expect(bindings).toHaveLength(2);
		expect(bindings.find((b) => b.appId === "cli_bot_a")?.sessionId).toBe("session_1");
		expect(bindings.find((b) => b.appId === "cli_bot_b")?.sessionId).toBe("session_2");
	});
});
