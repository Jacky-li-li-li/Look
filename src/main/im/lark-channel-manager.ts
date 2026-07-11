// ============================================================
// Feishu / Lark IM channel manager (main process)
// v2: 使用飞书官方 createLarkChannel() API
// ============================================================

import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
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
	senderId: string;
	senderName?: string;
	content: string;
	rawContentType: string;
	createTime: number;
	raw?: unknown;
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

/** 外部（LarkBridgeService）可注册的消息回调签名 */
export type NormalizedMessageHandler = (msg: NormalizedMessage) => void | Promise<void>;
export type ChannelLifecycleHandler = () => void | Promise<void>;

export class LarkChannelManager {
	private mainWindow: BrowserWindow;
	private channels: ImChannelConfig[] = [];
	// --- v2: 使用 createLarkChannel() 替代 WSClient + EventDispatcher ---
	private channel?: lark.LarkChannel;
	private client?: lark.Client;
	private status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
	private currentAppId?: string;
	private lastError?: string;
	private registrations = new Map<string, AbortController>();
	/** v2: 外部消息处理器（LarkBridgeService 注册） */
	private externalMessageHandler?: NormalizedMessageHandler;
	/** v2: 取消 channel.on('message') 订阅 */
	private unsubscribeMessage?: () => void;
	onConnectionReady?: ChannelLifecycleHandler;
	onConnectionClosed?: ChannelLifecycleHandler;

	constructor(mainWindow: BrowserWindow) {
		this.mainWindow = mainWindow;
	}

	setMainWindow(win: BrowserWindow): void {
		this.mainWindow = win;
	}

	// ============================================================
	// v2: 注册外部消息处理器（给 LarkBridgeService 使用）
	// ============================================================
	onMessage(handler?: NormalizedMessageHandler): void {
		this.externalMessageHandler = handler;
	}

	private notifyLifecycle(handler: ChannelLifecycleHandler | undefined, label: string): void {
		if (!handler) return;
		try {
			const result = handler();
			if (result && typeof result.catch === "function") {
				result.catch((err) => {
					console.warn(`[LarkChannelManager] ${label} lifecycle handler failed:`, err);
				});
			}
		} catch (err) {
			console.warn(`[LarkChannelManager] ${label} lifecycle handler failed:`, err);
		}
	}

	private sendRendererEvent(payload: ImRendererEvent): void {
		if (this.mainWindow && !this.mainWindow.isDestroyed()) {
			this.mainWindow.webContents.send("look:event", payload);
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

	// ============================================================
	// v2: connect() 使用 createLarkChannel()
	// ============================================================
	async connect(credentials: FeishuCredentials): Promise<void> {
		const { appId, appSecret, tenantBrand } = credentials;

		// 防止重复连接
		if (this.channel) {
			this.closeConnection();
		}

		this.currentAppId = appId;
		this.setStatus("connecting", appId);

		const domain = tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

		// v2: 使用 createLarkChannel() 替代 WSClient + EventDispatcher
		this.channel = lark.createLarkChannel({
			appId,
			appSecret,
			domain,
			transport: "websocket",
			policy: {
				dmMode: "open", // 私聊自动回复
				requireMention: false, // 不强制 @ 触发
			},
			safety: {
				chatQueue: { enabled: true }, // 内置 per-chat 串行
			},
			loggerLevel: lark.LoggerLevel.info,
			source: "look",
		});

		// v2: 通过 rawClient 获取原始 Client（用于 testConnection / sendTestMessage 等）
		this.client = this.channel.rawClient;

		// v2: 注册消息回调 → 归一化 NormalizedMessage（含重连/重连成功事件）
		this.unsubscribeMessage = this.channel.on({
			message: async (msg) => {
				console.log(
					"[LarkChannelManager] Message received:",
					msg.messageId,
					"chat:",
					msg.chatId,
					"content:",
					msg.content?.slice(0, 80),
				);
				await this.handleMessage(msg);
			},
			error: (err) => {
				console.warn("[LarkChannelManager] Channel error:", err.message);
				this.setStatus("error", appId, err);
			},
			reconnecting: () => {
				console.log("[LarkChannelManager] Reconnecting...");
				this.setStatus("connecting", appId);
			},
			reconnected: () => {
				console.log("[LarkChannelManager] Reconnected, botIdentity:", this.channel?.botIdentity?.openId);
				this.setStatus("connected", appId);
				this.notifyLifecycle(this.onConnectionReady, "connection-ready");
			},
		});

		// v2: connect() 内部处理 WebSocket 握手 + 自动重连 + 心跳
		try {
			await this.channel.connect();
			console.log("[LarkChannelManager] Connected OK, botIdentity:", this.channel.botIdentity?.openId);
			this.setStatus("connected", appId);
			this.notifyLifecycle(this.onConnectionReady, "connection-ready");
		} catch (err) {
			// 清理残留状态：channel 对象已创建但连接失败，
			// 避免桥接用断开的 channel 初始化
			console.error(
				"[LarkChannelManager] Connect failed, cleaning up:",
				err instanceof Error ? err.message : String(err),
			);
			this.unsubscribeMessage?.();
			this.unsubscribeMessage = undefined;
			this.channel = undefined;
			this.client = undefined;
			this.setStatus("error", appId, err);
			throw err;
		}
	}

	private closeConnection(): void {
		const hadChannel = Boolean(this.channel);
		try {
			this.unsubscribeMessage?.();
			this.unsubscribeMessage = undefined;
			this.channel?.disconnect().catch(() => {});
		} catch {
			// best-effort
		}
		this.channel = undefined;
		this.client = undefined;
		if (hadChannel) {
			this.notifyLifecycle(this.onConnectionClosed, "connection-closed");
		}
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

	// ============================================================
	// v2: 暴露 LarkChannel 实例（供 LarkBridgeService 使用）
	// ============================================================
	getLarkChannel(): lark.LarkChannel | undefined {
		return this.channel;
	}

	getRawClient(): lark.Client | undefined {
		return this.client;
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
		try {
			const appSecret = decryptSecret(channel);
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

	async testConnectionDirect(
		appId: string,
		appSecret: string,
		tenantBrand?: "feishu" | "lark",
	): Promise<{ success: boolean; message: string }> {
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

	// ============================================================
	// v2: handleMessage 接收 NormalizedMessage
	// ============================================================
	async handleMessage(msg: NormalizedMessage): Promise<void> {
		// v2: 转发 normalized 消息给外部处理器（LarkBridgeService）
		if (this.externalMessageHandler) {
			try {
				await this.externalMessageHandler(msg);
			} catch (err) {
				console.warn("[LarkChannelManager] External message handler error:", err);
			}
		}

		// 同时广播给渲染层（保持向后兼容）
		this.sendRendererEvent({
			type: "im:message-received",
			provider: "feishu",
			messageId: msg.messageId,
			chatId: msg.chatId,
			senderId: msg.senderId,
			senderName: msg.senderName,
			content: msg.content,
			rawContentType: msg.rawContentType,
			createTime: msg.createTime,
			raw: msg.raw,
		});
	}

	/** 判断消息是否来自 Bot 自身 */
	isSelfMessage(msg: NormalizedMessage): boolean {
		const botOpenId = this.channel?.botIdentity?.openId;
		return botOpenId ? msg.senderId === botOpenId : false;
	}

	async dispose(): Promise<void> {
		for (const [id, controller] of this.registrations) {
			controller.abort();
			this.registrations.delete(id);
		}
		// Close the channel without deleting saved channels so the Feishu
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
