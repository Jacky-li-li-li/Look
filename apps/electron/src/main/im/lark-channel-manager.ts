// ============================================================
// Feishu / Lark IM channel manager (main process)
// v2: 使用飞书官方 createLarkChannel() API
//
// 多连接模型：每个 appId 一条独立的 LarkChannel 连接，可同时在线。
// enabled 标记按渠道独立保存，重启后逐渠道恢复。
// ============================================================

import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import * as lark from "@larksuiteoapi/node-sdk";
import crypto from "crypto";
import type { BrowserWindow } from "electron";
import { BrowserWindowEventTransport, type RendererEventTransport } from "../ipc/renderer-event-transport.js";
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
	error?: string;
}

export interface SendTestMessageInput {
	receiveIdType: string;
	receiveId: string;
	text: string;
	card?: object;
}

export interface ManualConnectInput {
	appId: string;
	appSecret: string;
	name?: string;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** 单个 appId 的连接状态。channel/client 仅在连接建立后存在。 */
interface ConnectionEntry {
	channel?: lark.LarkChannel;
	client?: lark.Client;
	status: ConnectionStatus;
	lastError?: string;
	unsubscribeMessage?: () => void;
}

/** 外部（LarkBridgeService）可注册的消息回调签名：appId 标识是哪个 bot 收到的消息 */
export type NormalizedMessageHandler = (appId: string, msg: NormalizedMessage) => void | Promise<void>;
export type ChannelLifecycleHandler = (appId: string) => void | Promise<void>;

export class LarkChannelManager {
	private rendererEvents: RendererEventTransport;
	private channels: ImChannelConfig[] = [];
	// --- v2: 使用 createLarkChannel() 替代 WSClient + EventDispatcher ---
	/** appId → 独立连接。多 bot 同时在线，互不干扰。 */
	private connections = new Map<string, ConnectionEntry>();
	/** Ad-hoc API clients keyed by appId, for channels that are not the live connection. */
	private adHocClients = new Map<string, lark.Client>();
	private registrations = new Map<string, AbortController>();
	/** v2: 外部消息处理器（LarkBridgeService 注册） */
	private externalMessageHandler?: NormalizedMessageHandler;
	onConnectionReady?: ChannelLifecycleHandler;
	onConnectionClosed?: ChannelLifecycleHandler;

	constructor(target: BrowserWindow | RendererEventTransport) {
		this.rendererEvents = "send" in target ? target : new BrowserWindowEventTransport(() => target);
	}

	setMainWindow(win: BrowserWindow): void {
		this.rendererEvents = new BrowserWindowEventTransport(() => win);
	}

	// ============================================================
	// v2: 注册外部消息处理器（给 LarkBridgeService 使用）
	// ============================================================
	onMessage(handler?: NormalizedMessageHandler): void {
		this.externalMessageHandler = handler;
	}

	private notifyLifecycle(handler: ChannelLifecycleHandler | undefined, label: string, appId: string): void {
		if (!handler) return;
		try {
			const result = handler(appId);
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
		this.rendererEvents.send(payload);
	}

	/** 启动时并发恢复所有已启用的渠道，单个失败不影响其他渠道。 */
	async initialize(): Promise<void> {
		this.channels = loadChannels();
		const enabled = this.channels.filter(
			(c): c is ImChannelConfig & { appId: string } => c.provider === "feishu" && c.enabled && Boolean(c.appId),
		);
		await Promise.allSettled(
			enabled.map(async (channel) => {
				try {
					const appSecret = decryptSecret(channel);
					await this.connect({
						appId: channel.appId,
						appSecret,
						tenantBrand: channel.tenantBrand,
					});
				} catch (err) {
					console.warn(`[LarkChannelManager] Failed to connect ${channel.appId} on initialize:`, err);
					this.setStatus("error", channel.appId, err);
				}
			}),
		);
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
				// Reload from disk first so channels saved by other flows are not dropped.
				this.channels = loadChannels();
				this.channels = this.channels.filter((c) => !(c.provider === "feishu" && c.appId === result.client_id));
				this.channels.push(channel);
				saveChannels(this.channels);

				await this.connect({
					appId: result.client_id,
					appSecret: result.client_secret,
					tenantBrand: channel.tenantBrand,
				});
				this.setChannelEnabled(result.client_id, true);

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
		// The stored secret for this appId may have changed; drop any cached client.
		this.adHocClients.delete(appId);

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
		// Reload from disk first so channels saved by other flows are not dropped.
		this.channels = loadChannels();
		// Replace existing feishu channel with same appId, or add new one
		this.channels = this.channels.filter((c) => !(c.provider === "feishu" && c.appId === appId));
		this.channels.push(channel);
		saveChannels(this.channels);
		this.setChannelEnabled(appId, true);
	}

	/**
	 * 多连接模型：enabled 只描述"下次启动是否自动连接该渠道"，按渠道独立更新，
	 * 不再互斥（历史单连接模型会在连接成功时禁用其他所有渠道）。
	 */
	private setChannelEnabled(appId: string, enabled: boolean): void {
		let changed = false;
		for (const c of this.channels) {
			if (c.provider !== "feishu" || c.appId !== appId) continue;
			if (c.enabled !== enabled) {
				c.enabled = enabled;
				changed = true;
			}
		}
		if (changed) saveChannels(this.channels);
	}

	// ============================================================
	// v2: connect() 使用 createLarkChannel()，按 appId 独立建连
	// ============================================================
	async connect(credentials: FeishuCredentials): Promise<void> {
		const { appId, appSecret, tenantBrand } = credentials;

		// 同一 appId 的已有连接（重连/凭据变更场景）先关掉再建新，
		// 既不会产生重复客户端，也能让新凭据生效；其他渠道不受影响。
		const existing = this.connections.get(appId);
		if (existing?.channel) {
			this.closeConnection(appId);
		}

		const entry: ConnectionEntry = { status: "connecting" };
		this.connections.set(appId, entry);
		this.setStatus("connecting", appId);

		const domain = tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

		// v2: 使用 createLarkChannel() 替代 WSClient + EventDispatcher
		const channel = lark.createLarkChannel({
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
		entry.channel = channel;

		// v2: 通过 rawClient 获取原始 Client（用于 testConnection / sendTestMessage 等）
		entry.client = channel.rawClient;

		// v2: 注册消息回调 → 归一化 NormalizedMessage（含重连/重连成功事件）
		entry.unsubscribeMessage = channel.on({
			message: async (msg) => {
				console.log(
					"[LarkChannelManager] Message received:",
					msg.messageId,
					"appId:",
					appId,
					"chat:",
					msg.chatId,
					"content:",
					msg.content?.slice(0, 80),
				);
				await this.handleMessage(appId, msg);
			},
			error: (err) => {
				console.warn("[LarkChannelManager] Channel error:", appId, err.message);
				this.setStatus("error", appId, err);
			},
			reconnecting: () => {
				console.log("[LarkChannelManager] Reconnecting...", appId);
				this.setStatus("connecting", appId);
			},
			reconnected: () => {
				console.log("[LarkChannelManager] Reconnected, botIdentity:", appId, channel.botIdentity?.openId);
				this.setStatus("connected", appId);
				this.notifyLifecycle(this.onConnectionReady, "connection-ready", appId);
			},
		});

		// v2: connect() 内部处理 WebSocket 握手 + 自动重连 + 心跳
		try {
			await channel.connect();
			console.log("[LarkChannelManager] Connected OK, botIdentity:", appId, channel.botIdentity?.openId);
			this.setStatus("connected", appId);
			this.notifyLifecycle(this.onConnectionReady, "connection-ready", appId);
		} catch (err) {
			// 清理残留状态：channel 对象已创建但连接失败，
			// 避免桥接用断开的 channel 初始化
			console.error(
				"[LarkChannelManager] Connect failed, cleaning up:",
				appId,
				err instanceof Error ? err.message : String(err),
			);
			entry.unsubscribeMessage?.();
			entry.unsubscribeMessage = undefined;
			entry.channel = undefined;
			entry.client = undefined;
			this.setStatus("error", appId, err);
			throw err;
		}
	}

	private closeConnection(appId: string): void {
		const entry = this.connections.get(appId);
		if (!entry) return;
		const hadChannel = Boolean(entry.channel);
		try {
			entry.unsubscribeMessage?.();
			entry.unsubscribeMessage = undefined;
			entry.channel?.disconnect().catch((err) => {
				console.error("[LarkChannelManager] disconnect failed:", err);
			});
		} catch {
			// best-effort
		}
		entry.channel = undefined;
		entry.client = undefined;
		if (hadChannel) {
			this.notifyLifecycle(this.onConnectionClosed, "connection-closed", appId);
		}
		this.setStatus("disconnected", appId);
	}

	/** 断开指定渠道（不影响其他渠道的连接与 enabled 标记）。 */
	async disconnect(provider?: string, appId?: string): Promise<void> {
		this.channels = loadChannels();
		// Mark the matching channel as disabled rather than deleting it, so the
		// user can reconnect later without re-registering.
		const targetProvider = provider ?? "feishu";
		let changed = false;
		for (const c of this.channels) {
			if (c.provider === targetProvider && (!appId || c.appId === appId)) {
				if (c.appId) this.closeConnection(c.appId);
				if (c.enabled) {
					c.enabled = false;
					changed = true;
				}
			}
		}
		if (changed) saveChannels(this.channels);
	}

	async removeChannel(provider: string, appId: string): Promise<void> {
		// If the channel being removed is currently connected, close it first.
		this.closeConnection(appId);
		this.connections.delete(appId);
		this.adHocClients.delete(appId);
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
		this.setChannelEnabled(channel.appId, true);
	}

	// ============================================================
	// v2: 暴露 LarkChannel 实例（供 LarkBridgeService 使用）
	// ============================================================

	/** appId 指定时返回该渠道的连接（未连接返回 undefined）；省略时返回任一已连接渠道。 */
	getLarkChannel(appId?: string): lark.LarkChannel | undefined {
		if (appId) {
			const entry = this.connections.get(appId);
			return entry?.status === "connected" ? entry.channel : undefined;
		}
		for (const entry of this.connections.values()) {
			if (entry.status === "connected" && entry.channel) return entry.channel;
		}
		return undefined;
	}

	getRawClient(appId?: string): lark.Client | undefined {
		if (appId) return this.connections.get(appId)?.client;
		for (const entry of this.connections.values()) {
			if (entry.client) return entry.client;
		}
		return undefined;
	}

	/** appId of the first connected channel, if any. */
	getConnectedAppId(): string | undefined {
		return this.getConnectedAppIds()[0];
	}

	/** appIds of all currently connected channels. */
	getConnectedAppIds(): string[] {
		const appIds: string[] = [];
		for (const [appId, entry] of this.connections) {
			if (entry.status === "connected" && entry.channel) appIds.push(appId);
		}
		return appIds;
	}

	/**
	 * Resolve an API client for a channel. The live connection's client is used
	 * when appId matches (or is omitted); otherwise an ad-hoc client is built
	 * from the stored credentials and cached. Sending messages only needs a
	 * tenant token, so this works even when that channel is not connected.
	 */
	getClient(appId?: string): lark.Client | undefined {
		if (!appId) {
			for (const entry of this.connections.values()) {
				if (entry.client) return entry.client;
			}
			return undefined;
		}
		const live = this.connections.get(appId)?.client;
		if (live) return live;
		const cached = this.adHocClients.get(appId);
		if (cached) return cached;
		const config = loadChannels().find((c) => c.provider === "feishu" && c.appId === appId);
		if (!config) return undefined;
		try {
			const client = new lark.Client({
				appId,
				appSecret: decryptSecret(config),
				appType: lark.AppType.SelfBuild,
				domain: config.tenantBrand === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			});
			this.adHocClients.set(appId, client);
			return client;
		} catch (err) {
			console.warn("[LarkChannelManager] Failed to build ad-hoc client for", appId, err);
			return undefined;
		}
	}

	/**
	 * Best-effort chat metadata lookup (chat type / name). Returns null when the
	 * app lacks im:chat:read or the request otherwise fails — callers must treat
	 * the type as unknown rather than an error.
	 */
	async getChatInfo(chatId: string, appId?: string): Promise<{ chatType?: "p2p" | "group"; name?: string } | null> {
		const client = this.getClient(appId);
		if (!client) return null;
		try {
			const resp = await client.im.v1.chat.get({ path: { chat_id: chatId } });
			// The SDK resolves with the raw response; business errors (e.g. the bot
			// is not in this chat) surface as a non-zero code with no data.
			if (resp?.code !== 0) return null;
			const data = resp?.data as { chat_mode?: string; name?: string } | undefined;
			if (!data) return null;
			const chatType = data.chat_mode === "p2p" ? "p2p" : data.chat_mode === "group" ? "group" : undefined;
			return { chatType, name: data.name || undefined };
		} catch (err) {
			console.warn("[LarkChannelManager] chat.get failed for", chatId, err);
			return null;
		}
	}

	/**
	 * Send a text/card message to a chat through the given channel (defaults to
	 * the live connection). Used by scheduled-task notifications.
	 */
	async sendToChat(
		appId: string | undefined,
		chatId: string,
		content: { text: string; card?: object },
	): Promise<{ success: boolean; error?: string }> {
		const client = this.getClient(appId);
		if (!client) {
			return { success: false, error: "Feishu client is not available for the selected bot channel" };
		}
		return this.deliverMessage(client, "chat_id", chatId, content);
	}

	/** Shared low-level send with Feishu error extraction. */
	private async deliverMessage(
		client: lark.Client,
		receiveIdType: string,
		receiveId: string,
		content: { text: string; card?: object },
	): Promise<{ success: boolean; error?: string }> {
		try {
			const data = content.card
				? {
						receive_id: receiveId,
						content: JSON.stringify(content.card),
						msg_type: "interactive" as const,
					}
				: {
						receive_id: receiveId,
						content: JSON.stringify({ text: content.text }),
						msg_type: "text" as const,
					};
			await client.im.v1.message.create({
				params: {
					receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" | "union_id" | "email",
				},
				data,
			});
			return { success: true };
		} catch (err) {
			// 飞书/百合的错误详情在 response.data 里（如 code 230001 invalid receive_id），
			// 只取 err.message 会丢掉最有用的排查信息。
			const feishuError = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
			const message = feishuError?.msg
				? `Feishu error ${feishuError.code}: ${feishuError.msg}`
				: err instanceof Error
					? err.message
					: String(err);
			return { success: false, error: message };
		}
	}

	getChannels(): LarkChannelListItem[] {
		return this.channels.map((c) => {
			const entry = c.appId ? this.connections.get(c.appId) : undefined;
			const status = entry?.status ?? "disconnected";
			return {
				provider: c.provider,
				appId: c.appId,
				name: c.name,
				status,
				connected: status === "connected" && Boolean(entry?.channel),
				enabled: c.enabled,
				...(entry?.lastError ? { error: entry.lastError } : {}),
			};
		});
	}

	async sendTestMessage(input: SendTestMessageInput): Promise<{ success: boolean; error?: string }> {
		const client = this.getClient();
		if (!client) {
			return { success: false, error: "Feishu client is not connected" };
		}
		return this.deliverMessage(client, input.receiveIdType, input.receiveId, {
			text: input.text,
			card: input.card,
		});
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
	async handleMessage(appId: string, msg: NormalizedMessage): Promise<void> {
		// v2: 转发 normalized 消息给外部处理器（LarkBridgeService）
		if (this.externalMessageHandler) {
			try {
				await this.externalMessageHandler(appId, msg);
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
	isSelfMessage(appId: string, msg: NormalizedMessage): boolean {
		const botOpenId = this.connections.get(appId)?.channel?.botIdentity?.openId;
		return botOpenId ? msg.senderId === botOpenId : false;
	}

	async dispose(): Promise<void> {
		for (const [id, controller] of this.registrations) {
			controller.abort();
			this.registrations.delete(id);
		}
		this.adHocClients.clear();
		// Close all channels without deleting saved channels so the Feishu
		// integration survives an app restart.
		for (const appId of Array.from(this.connections.keys())) {
			this.closeConnection(appId);
		}
	}

	private setStatus(status: ConnectionStatus, appId?: string, err?: unknown): void {
		let lastError: string | undefined;
		if (appId) {
			const entry = this.connections.get(appId) ?? { status: "disconnected" as ConnectionStatus };
			entry.status = status;
			entry.lastError = status === "error" ? (err instanceof Error ? err.message : String(err)) : undefined;
			this.connections.set(appId, entry);
			lastError = entry.lastError;
		}
		this.sendRendererEvent({
			type: "im:channel-status",
			provider: "feishu",
			status,
			appId,
			error: lastError,
		});
	}
}
