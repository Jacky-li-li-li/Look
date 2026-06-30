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
		name?: string;
	tenantBrand?: "feishu" | "lark";
}

export interface LarkChannelListItem {
	provider: string;
	appId: string;
	name?: string;
	status: string;
	connected: boolean;
	enabled: boolean;
}


export interface SendTestMessageInput {
	receiveIdType: string;
	receiveId: string;
	text: string;
}

export interface ManualConnectInput {
	appId: string;
	appSecret: string;
		name?: string;
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
			await this.connect({
				appId: enabled.appId,
				appSecret,
				tenantBrand: enabled.tenantBrand,
			});
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
							expireIn: Math.min(info.expireIn, 180),
						});
					},
					onStatusChange: (_info) => {
						// SDK statuses here describe the device-code polling loop
						// (polling | slow_down | domain_switched). They are not UI
						// phases and must not overwrite the QR URL emitted by
						// onQRCodeReady.
					},
				});

				const encrypted = encryptSecret(result.client_secret);
				const channel: ImChannelConfig = {
					provider: "feishu",
					appId: result.client_id,
					name: appName,
					enabled: true,
					createdAt: Date.now(),
					tenantBrand: result.user_info?.tenant_brand,
					...(encrypted && "encrypted" in encrypted
						? { appSecretEncrypted: encrypted.encrypted }
						: { appSecretPlain: encrypted.plain }),
				};
				this.channels = this.channels.filter((c) => !(c.provider === "feishu" && c.appId === result.client_id));
				this.channels.push(channel);
				saveChannels(this.channels);

				await this.connect({
					appId: result.client_id,
					appSecret: result.client_secret,
					tenantBrand: channel.tenantBrand,
				});

				this.sendRendererEvent({
					type: "im:registration-update",
					registrationId,
					phase: "success",
					appId: result.client_id,
				});
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

	async connectManual(input: ManualConnectInput): Promise<void> {
		const appId = input.appId.trim();
		const appSecret = input.appSecret.trim();
		if (!appId) {
			throw new Error("App ID is required");
		}
		if (!appSecret) {
			throw new Error("App Secret is required");
		}

		await this.connect({ appId, appSecret });

		const encrypted = encryptSecret(appSecret);
		const channel: ImChannelConfig = {
			provider: "feishu",
			appId,
			name: input.name ?? `Feishu (${appId.slice(0, 8)}...)`,
			enabled: true,
			createdAt: Date.now(),
			...(encrypted && "encrypted" in encrypted
				? { appSecretEncrypted: encrypted.encrypted }
				: { appSecretPlain: encrypted.plain }),
		};
		// Replace existing feishu channel with same appId, or add new one
		this.channels = this.channels.filter((c) => !(c.provider === "feishu" && c.appId === appId));
		this.channels.push(channel);
		saveChannels(this.channels);
	}

	async connect(credentials: FeishuCredentials): Promise<void> {
		const { appId, appSecret, tenantBrand } = credentials;

		// Prevent duplicate/leaked WebSocket clients if connect is called while
		// already connected or connecting.
		if (this.wsClient) {
			this.closeConnection();
		}

		this.currentAppId = appId;
		this.setStatus("connecting", appId);

		try {
			const domain = tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
			this.client = new lark.Client({
				appId,
				appSecret,
				appType: lark.AppType.SelfBuild,
				domain,
			});

			this.eventDispatcher = new lark.EventDispatcher({}).register({
				"im.message.receive_v1": async (data) => {
					this.handleMessage(data);
				},
			});

			this.wsClient = new lark.WSClient({
				appId,
				appSecret,
				domain,
				loggerLevel: lark.LoggerLevel.info,
				// Disable SDK auto-reconnect; lifecycle is managed explicitly so
				// manual disconnect does not turn into a zombie reconnect loop.
				autoReconnect: false,
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

	private closeConnection(): void {
		try {
			this.wsClient?.close({ force: true });
		} catch {
			// best-effort
		}
		this.client = undefined;
		this.wsClient = undefined;
		this.eventDispatcher = undefined;
		const previousAppId = this.currentAppId;
		this.currentAppId = undefined;
		if (previousAppId) {
			this.setStatus("disconnected", previousAppId);
		} else {
			this.status = "disconnected";
			this.lastError = undefined;
		}
	}

	async disconnect(provider?: string, appId?: string): Promise<void> {
		const previousAppId = this.currentAppId;
		this.closeConnection();
		this.channels = loadChannels();
		// Mark the matching channel as disabled rather than deleting it, so the
		// user can reconnect later without re-registering.
		const targetProvider = provider ?? "feishu";
		const targetAppId = appId ?? previousAppId;
		let changed = false;
		for (const c of this.channels) {
			if (c.provider === targetProvider && (!targetAppId || c.appId === targetAppId)) {
				c.enabled = false;
				changed = true;
			}
		}
		if (changed) saveChannels(this.channels);
	}

	async removeChannel(provider: string, appId: string): Promise<void> {
		// If the channel being removed is currently connected, close it first.
		if (this.currentAppId === appId) {
			this.closeConnection();
		}
		this.channels = loadChannels();
		this.channels = this.channels.filter((c) => c.provider !== provider || c.appId !== appId);
		saveChannels(this.channels);
	}

	async reconnect(provider: string, appId: string): Promise<void> {
		this.channels = loadChannels();
		const channel = this.channels.find((c) => c.provider === provider && c.appId === appId);
		if (!channel) {
			throw new Error(`Channel not found: ${provider}:${appId}`);
		}
		const appSecret = decryptSecret(channel);
		await this.connect({ appId: channel.appId, appSecret, tenantBrand: channel.tenantBrand });
		channel.enabled = true;
		saveChannels(this.channels);
	}

	getChannels(): LarkChannelListItem[] {
		return this.channels.map((c) => ({
			provider: c.provider,
			appId: c.appId,
			name: c.name,
			status: this.status,
			connected: this.status === "connected" && this.currentAppId === c.appId,
			enabled: c.enabled,
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



	async testConnection(appId: string): Promise<{ success: boolean; message: string }> {
		const channels = loadChannels();
		const channel = channels.find((c) => c.appId === appId);
		if (!channel) {
			return { success: false, message: "Channel not found" };
		}
		const appSecret = decryptSecret(channel);
		try {
			const client = new lark.Client({
				appId,
				appSecret,
				appType: lark.AppType.SelfBuild,
				domain: channel.tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			});
			const resp = await client.auth.tenantAccessToken.internal({
				data: { app_id: appId, app_secret: appSecret },
			});
			if (resp.code === 0) {
				return { success: true, message: "连接成功" };
			}
			return { success: false, message: `飞书 API 错误: ${resp.msg ?? "未知错误"} (code: ${resp.code})` };
		} catch (error) {
			return { success: false, message: `连接失败: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	async testConnectionDirect(appId: string, appSecret: string, tenantBrand?: "feishu" | "lark"): Promise<{ success: boolean; message: string }> {
		try {
			const client = new lark.Client({
				appId,
				appSecret,
				appType: lark.AppType.SelfBuild,
				domain: tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			});
			const resp = await client.auth.tenantAccessToken.internal({
				data: { app_id: appId, app_secret: appSecret },
			});
			if (resp.code === 0) {
				return { success: true, message: "连接成功" };
			}
			return { success: false, message: `飞书 API 错误: ${resp.msg ?? "未知错误"} (code: ${resp.code})` };
		} catch (error) {
			return { success: false, message: `连接失败: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	async updateChannel(appId: string, updates: { name?: string }): Promise<void> {
		const channel = this.channels.find((c) => c.appId === appId);
		if (!channel) {
			throw new Error("Channel not found");
		}
		if (updates.name !== undefined) {
			channel.name = updates.name;
		}
		saveChannels(this.channels);
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
		// Close the WebSocket without deleting saved channels so the Feishu
		// integration survives an app restart.
		this.closeConnection();
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
