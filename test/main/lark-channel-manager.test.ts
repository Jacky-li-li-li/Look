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
	const makeClient = vi.fn().mockImplementation((params: any) => ({
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
			},
		},
	}));

	const channels: any[] = [];
	const createLarkChannel = vi.fn().mockImplementation((params: any) => {
		const handlers: Record<string, any> = {};
		const streamControllers: any[] = [];
		const channel = {
			params,
			rawClient: makeClient(params),
			botIdentity: { openId: "bot_open_id", name: "Look Bot" },
			streamControllers,
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn().mockResolvedValue(undefined),
			on: vi.fn().mockImplementation((nameOrHandlers: string | Record<string, any>, handler?: any) => {
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
			}),
			send: vi.fn().mockResolvedValue({ messageId: "sent_message" }),
			stream: vi.fn().mockImplementation(async (_to: string, input: any) => {
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

import { BrowserWindow } from "electron";
import { LarkBridgeService } from "../../src/main/im/lark-bridge-service.js";
import { LarkChannelManager } from "../../src/main/im/lark-channel-manager.js";
import type { MainToRendererEvent } from "../../src/main/shared/types.js";

function createMainWindow(): BrowserWindow {
	return new BrowserWindow({} as any);
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

function readChannels(): unknown {
	return JSON.parse(readFileSync(join(mocks.lookDir, "im-channels.json"), "utf8"));
}

function sampleMessage(content = "hello"): NormalizedMessage {
	return {
		messageId: `msg_${Math.random().toString(36).slice(2)}`,
		chatId: "chat_1",
		chatType: "p2p" as any,
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
	customSendMessage?: (
		sessionId: string,
		emit: (event: MainToRendererEvent) => void,
	) => void | Promise<void>,
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
						stats: {} as any,
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

function findCollapsiblePanels(card: any): any[] {
	const found: any[] = [];
	const visit = (node: any) => {
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

	it("prevents duplicate channel clients when connect is called twice", async () => {
		const manager = new LarkChannelManager(createMainWindow());
		await manager.connect({ appId: "cli_first", appSecret: "secret" });
		const firstDisconnect = larkMocks.channels[0].disconnect;
		await manager.connect({ appId: "cli_second", appSecret: "secret" });

		expect(larkMocks.createLarkChannel).toHaveBeenCalledTimes(2);
		expect(firstDisconnect).toHaveBeenCalledTimes(1);
		expect(larkMocks.channels[1].connect).toHaveBeenCalledTimes(1);
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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);
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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

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
					stats: {} as any,
				},
			});
		});
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

		await manager.connectManual({ appId: "cli_manual", appSecret: "secret" });
		await larkMocks.channels[0].emit("message", sampleMessage("run pwd"));
		await flushAsync();

		const controller = larkMocks.channels[0].streamControllers[0];
		const updatedCards = controller.update.mock.calls.map((call: any[]) => call[0]);
		const panels = updatedCards.flatMap(findCollapsiblePanels);
		expect(
			panels.some(
				(panel) => panel.header?.title?.content === "工具 · bash · 运行中" && panel.expanded === true,
			),
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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);
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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

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
		manager.onConnectionReady = () => bridge.init(runtime as any, manager);

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
});
