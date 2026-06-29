// ============================================================
// Feishu / Lark IM channel manager (main process)
// ============================================================

import * as lark from "@larksuiteoapi/node-sdk";
import crypto from "crypto";
import type { BrowserWindow } from "electron";
import {
	decryptSecret,
	encryptSecret,
	type ImChannelConfig,
	type ImProvider,
	loadChannels,
	saveChannels,
} from "./im-storage.js";

// Local event payload shapes until the shared types are extended by main-ipc.
type ImRegistrationUpdateEvent = {
	type: "im:registration-update";
	registrationId: string;
	phase: "qr" | "polling" | "success" | "error";
	url?: string;
	expireIn?: number;
	error?: string;
	appId?: string;
};

type ImChannelStatusEvent = {
	type: "im:channel-status";
	provider: ImProvider;
	status: "connected" | "disconnected" | "connecting" | "error";
	appId?: string;
	error?: string;
};

type ImMessageReceivedEvent = {
	type: "im:message-received";
	provider: ImProvider;
	messageId: string;
	chatId: string;
	senderOpenId: string;
	content: unknown;
	createTime: number;
};

type ImRendererEvent = ImRegistrationUpdateEvent | ImChannelStatusEvent | ImMessageReceivedEvent;

// Feishu tenant scopes from the official one-click app-creation guide.
const FEISHU_TENANT_SCOPES = [
	"contact:contact.base:readonly",
	"im:chat:create",
	"im:chat:read",
	"im:chat:update",
	"im:message.group_at_msg:readonly",
	"im:message.p2p_msg:readonly",
	"im:message.pins:read",
	"im:message.pins:write_only",
	"im:message.reactions:read",
	"im:message.reactions:write_only",
	"im:message:readonly",
	"im:message:send_as_bot",
	"im:message:send_multi_users",
	"im:message:send_sys_msg",
	"im:message:update",
	"im:resource",
	"im:message.group_at_msg.include_bot:readonly",
	"application:bot.basic_info:read",
	"application:application:self_manage",
	"cardkit:card:write",
	"cardkit:card:read",
	"application:bot.menu:write",
	"im:chat.members:bot_access",
	"drive:drive.metadata:readonly",
	"docs:document.comment:create",
	"docs:document.comment:delete",
	"docs:document.comment:read",
	"docs:document.comment:update",
	"docs:document.comment:write_only",
	"docx:document:readonly",
	"docx:document:write_only",
	"wiki:node:read",
	"docx:document.block:convert",
	"application:app_slash_command:read",
	"application:app_slash_command:write",
];

interface FeishuCredentials {
	appId: string;
	appSecret: string;
}

export interface LarkChannelListItem {
	provider: string;
	appId: string;
	name?: string;
	status: string;
	connected: boolean;
}

export interface SendTestMessageInput {
	receiveIdType: string;
	receiveId: string;
	text: string;
}

export class LarkChannelManager {
	private mainWindow: BrowserWindow;
	private channels: ImChannelConfig[] = [];
	private client?: lark.Client;
	private wsClient?: lark.WSClient;
	private eventDispatcher?: lark.EventDispatcher;
	private status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
	private currentAppId?: string;
	private lastError?: string;
	private registrations = new Map<string, AbortController>();

	constructor(mainWindow: BrowserWindow) {
		this.mainWindow = mainWindow;
	}

	setMainWindow(win: BrowserWindow): void {
		this.mainWindow = win;
	}

	private sendRendererEvent(payload: ImRendererEvent): void {
		if (this.mainWindow && !this.mainWindow.isDestroyed()) {
			this.mainWindow.webContents.send("look:event", payload as any);
		}
	}

	async initialize(): Promise<void> {
		this.channels = loadChannels();
		const enabled = this.channels.find(
			(c): c is ImChannelConfig & { appId: string } => c.provider === "feishu" && c.enabled && Boolean(c.appId),
		);
		if (!enabled) return;

		try {
			const appSecret = decryptSecret(enabled);
			await this.connect({ appId: enabled.appId, appSecret });
		} catch (err) {
			console.warn("[LarkChannelManager] Failed to connect on initialize:", err);
			this.setStatus("error", enabled.appId, err);
		}
	}

	async startRegistration(options?: {
		appName?: string;
		description?: string;
	}): Promise<{ success: true; registrationId: string }> {
		const registrationId = crypto.randomUUID();
		const appName = options?.appName ?? "Look Feishu Bot";
		const description = options?.description;
		const controller = new AbortController();
		this.registrations.set(registrationId, controller);

		const run = async () => {
			try {
				const result = await lark.registerApp({
					createOnly: true,
					signal: controller.signal,
					appPreset: {
						name: appName,
						desc: description,
					},
					addons: {
						scopes: {
							tenant: FEISHU_TENANT_SCOPES,
						},
						events: {
							items: {
								tenant: ["im.message.receive_v1"],
							},
						},
						callbacks: {
							items: ["card.action.trigger"],
						},
					},
					onQRCodeReady: (info) => {
						this.sendRendererEvent({
							type: "im:registration-update",
							registrationId,
							phase: "qr",
							url: info.url,
							expireIn: info.expireIn,
						});
					},
					onStatusChange: (info) => {
						this.sendRendererEvent({
							type: "im:registration-update",
							registrationId,
							phase: info.status === "polling" ? "polling" : "polling",
						});
					},
				});

				const encrypted = encryptSecret(result.client_secret);
				const channel: ImChannelConfig = {
					provider: "feishu",
					appId: result.client_id,
					name: appName,
					enabled: true,
					createdAt: Date.now(),
					...(encrypted && "encrypted" in encrypted
						? { appSecretEncrypted: encrypted.encrypted }
						: { appSecretPlain: encrypted.plain }),
				};
				this.channels = this.channels.filter((c) => c.provider !== "feishu" || c.appId !== result.client_id);
				this.channels.push(channel);
				saveChannels(this.channels);

				this.sendRendererEvent({
					type: "im:registration-update",
					registrationId,
					phase: "success",
					appId: result.client_id,
				});

				await this.connect({ appId: result.client_id, appSecret: result.client_secret });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.sendRendererEvent({
					type: "im:registration-update",
					registrationId,
					phase: "error",
					error: message,
				});
			} finally {
				this.registrations.delete(registrationId);
			}
		};

		void run();
		return { success: true, registrationId };
	}

	cancelRegistration(registrationId: string): void {
		const controller = this.registrations.get(registrationId);
		if (controller) {
			controller.abort();
			this.registrations.delete(registrationId);
		}
	}

	async connect(credentials: FeishuCredentials): Promise<void> {
		const { appId, appSecret } = credentials;
		this.currentAppId = appId;
		this.setStatus("connecting", appId);

		try {
			this.client = new lark.Client({
				appId,
				appSecret,
				appType: lark.AppType.SelfBuild,
				domain: lark.Domain.Feishu,
			});

			this.eventDispatcher = new lark.EventDispatcher({}).register({
				"im.message.receive_v1": async (data) => {
					this.handleMessage(data);
				},
			});

			this.wsClient = new lark.WSClient({
				appId,
				appSecret,
				loggerLevel: lark.LoggerLevel.info,
				onReady: () => {
					this.setStatus("connected", appId);
				},
				onError: (err) => {
					this.setStatus("error", appId, err);
				},
			});

			await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
			this.setStatus("connected", appId);
		} catch (err) {
			this.setStatus("error", appId, err);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		try {
			this.wsClient?.close({ force: true });
		} catch {
			// best-effort
		}
		this.client = undefined;
		this.wsClient = undefined;
		this.eventDispatcher = undefined;
		const previousAppId = this.currentAppId;
		this.channels = this.channels.filter((c) => c.provider !== "feishu");
		saveChannels(this.channels);
		this.setStatus("disconnected", previousAppId);
		this.currentAppId = undefined;
	}

	getChannels(): LarkChannelListItem[] {
		return this.channels.map((c) => ({
			provider: c.provider,
			appId: c.appId,
			name: c.name,
			status: this.status,
			connected: this.status === "connected" && this.currentAppId === c.appId,
		}));
	}

	async sendTestMessage(input: SendTestMessageInput): Promise<{ success: boolean; error?: string }> {
		if (!this.client) {
			return { success: false, error: "Feishu client is not connected" };
		}
		try {
			await this.client.im.v1.message.create({
				params: {
					receive_id_type: input.receiveIdType as "chat_id" | "open_id" | "user_id" | "union_id" | "email",
				},
				data: {
					receive_id: input.receiveId,
					content: JSON.stringify({ text: input.text }),
					msg_type: "text",
				},
			});
			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		}
	}

	handleMessage(data: {
		sender?: {
			sender_id?: { open_id?: string };
		};
		message?: {
			message_id?: string;
			chat_id?: string;
			content?: string;
			create_time?: string;
		};
	}): void {
		const message = data.message;
		if (!message) return;
		let content: unknown;
		try {
			content = message.content ? JSON.parse(message.content) : {};
		} catch {
			content = message.content ?? {};
		}
		this.sendRendererEvent({
			type: "im:message-received",
			provider: "feishu",
			messageId: message.message_id ?? "",
			chatId: message.chat_id ?? "",
			senderOpenId: data.sender?.sender_id?.open_id ?? "",
			content,
			createTime: message.create_time ? Number.parseInt(message.create_time, 10) : Date.now(),
		});
	}

	async dispose(): Promise<void> {
		for (const [id, controller] of this.registrations) {
			controller.abort();
			this.registrations.delete(id);
		}
		await this.disconnect();
	}

	private setStatus(
		status: "connected" | "disconnected" | "connecting" | "error",
		appId?: string,
		err?: unknown,
	): void {
		this.status = status;
		if (status === "error") {
			this.lastError = err instanceof Error ? err.message : String(err);
		} else {
			this.lastError = undefined;
		}
		this.sendRendererEvent({
			type: "im:channel-status",
			provider: "feishu",
			status,
			appId,
			error: this.lastError,
		});
	}
}
