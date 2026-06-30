// ============================================================
// IM channel persistence
// ============================================================

import { safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { getLookDir } from "../shared/look-storage.js";

export type ImProvider = "feishu";

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
	const dir = path.dirname(CHANNELS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tempPath = `${CHANNELS_FILE}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(channels, null, 2));
	fs.renameSync(tempPath, CHANNELS_FILE);
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
