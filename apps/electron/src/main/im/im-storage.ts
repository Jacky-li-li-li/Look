// ============================================================
// IM channel persistence
// ============================================================

import { getLookDir } from "@look/shared/look-storage";
import { safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { writeJsonFile } from "../utils/atomic-writer.js";

export type ImProvider = "feishu";

// ============================================================
// ChatBinding — 飞书 chatId → Agent sessionId 绑定
// ============================================================
export interface ChatBinding {
	chatId: string;
	sessionId: string;
	projectId: string;
	createdAt: number;
	/** 产生该绑定的渠道（机器人）。旧数据可能缺失，解析时会自愈回填。 */
	appId?: string;
	/** p2p = 与某个用户的私聊；group = 群聊。 */
	chatType?: "p2p" | "group";
	/** 私聊对端的 open_id（消息发送者）。 */
	senderOpenId?: string;
	/** 私聊对端姓名（消息发送者）。 */
	peerName?: string;
}

const BINDINGS_FILE = path.join(getLookDir(), "im-bindings.json");

export function getBindingsFilePath(): string {
	return BINDINGS_FILE;
}

export function loadBindings(): ChatBinding[] {
	if (!fs.existsSync(BINDINGS_FILE)) {
		return [];
	}
	try {
		const raw = fs.readFileSync(BINDINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			console.warn("[IMStorage] im-bindings.json is not an array, resetting");
			return [];
		}
		return parsed as ChatBinding[];
	} catch (err) {
		console.warn("[IMStorage] Failed to load bindings:", err);
		return [];
	}
}

export function saveBindings(bindings: ChatBinding[]): void {
	writeJsonFile(BINDINGS_FILE, bindings, 2);
}

export interface ImChannelConfig {
	provider: ImProvider;
	appId: string;
	appSecretEncrypted?: string;
	appSecretPlain?: string;
	name?: string;
	enabled: boolean;
	createdAt: number;
	/** Tenant brand returned by registerApp: 'feishu' | 'lark'. */
	tenantBrand?: "feishu" | "lark";
}

export type EncryptedSecretResult = { encrypted: string } | { plain: string };

const CHANNELS_FILE = path.join(getLookDir(), "im-channels.json");

export function getChannelsFilePath(): string {
	return CHANNELS_FILE;
}

export function loadChannels(): ImChannelConfig[] {
	if (!fs.existsSync(CHANNELS_FILE)) {
		return [];
	}
	try {
		const raw = fs.readFileSync(CHANNELS_FILE, "utf8");
		const parsed = JSON.parse(raw) as ImChannelConfig[];
		if (!Array.isArray(parsed)) {
			console.warn("[IMStorage] im-channels.json is not an array, resetting");
			return [];
		}
		return parsed;
	} catch (err) {
		console.warn("[IMStorage] Failed to load channels:", err);
		return [];
	}
}

export function saveChannels(channels: ImChannelConfig[]): void {
	writeJsonFile(CHANNELS_FILE, channels, 2);
}

export function encryptSecret(secret: string): EncryptedSecretResult {
	if (safeStorage.isEncryptionAvailable()) {
		try {
			const encrypted = safeStorage.encryptString(secret);
			return { encrypted: Buffer.from(encrypted).toString("base64") };
		} catch (err) {
			console.warn("[IMStorage] safeStorage encryption failed, falling back to plain storage:", err);
		}
	} else {
		console.warn("[IMStorage] safeStorage is not available, storing secret as plain text");
	}
	return { plain: secret };
}

export function decryptSecret(channel: ImChannelConfig): string {
	if (channel.appSecretEncrypted) {
		const encryptedBuffer = Buffer.from(channel.appSecretEncrypted, "base64");
		return safeStorage.decryptString(encryptedBuffer);
	}
	if (channel.appSecretPlain) {
		return channel.appSecretPlain;
	}
	throw new Error("Channel has no stored secret");
}
