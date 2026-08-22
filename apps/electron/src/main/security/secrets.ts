// ============================================================
// Secrets — safeStorage-backed API key encryption/decryption
//
// Uses Electron's safeStorage (OS keychain) to protect API keys
// stored in auth.json and custom-providers.json. Mirrors the
// pattern established in im-storage.ts for IM appSecret storage.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { safeStorage } from "electron";
import { writeJsonFile } from "../utils/atomic-writer.js";

const ENCRYPTED_PREFIX = "enc:";

export function isEncrypted(value: string): boolean {
	return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptApiKey(key: string): string {
	if (!key) return key;
	if (isEncrypted(key)) return key;
	if (safeStorage?.isEncryptionAvailable()) {
		try {
			const encrypted = safeStorage.encryptString(key);
			return ENCRYPTED_PREFIX + Buffer.from(encrypted).toString("base64");
		} catch (err) {
			console.warn("[Secrets] safeStorage encryption failed, storing as plain text:", err);
		}
	} else {
		console.warn("[Secrets] safeStorage is not available, storing API key as plain text");
	}
	return key;
}

export function decryptApiKey(stored: string): string {
	if (!stored) return stored;
	if (isEncrypted(stored) && safeStorage?.isEncryptionAvailable()) {
		const base64 = stored.slice(ENCRYPTED_PREFIX.length);
		const encryptedBuffer = Buffer.from(base64, "base64");
		return safeStorage.decryptString(encryptedBuffer);
	}
	return stored;
}

export function isEncryptionAvailable(): boolean {
	return safeStorage?.isEncryptionAvailable() ?? false;
}

/**
 * CredentialStore wrapper that transparently encrypts/decrypts API keys
 * via Electron safeStorage before writing to / after reading from disk.
 *
 * Used by ModelRuntime to persist credentials with at-rest encryption.
 */
export class EncryptedCredentialStore implements CredentialStore {
	/** Serialize modify/delete per the pi-ai CredentialStore contract. */
	private _writeLock: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		this.touchFile();
	}

	/** Acquire the write lock, execute fn, release. */
	private async _withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this._writeLock;
		let release!: () => void;
		this._writeLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private touchFile(): void {
		try {
			if (!fs.existsSync(this.filePath)) {
				fs.writeFileSync(this.filePath, "{}", { mode: 0o600 });
			}
		} catch {
			// race, ignore
		}
	}

	private readData(): Record<string, Credential> {
		try {
			return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
		} catch {
			return {};
		}
	}

	private writeData(data: Record<string, Credential>): void {
		// mode 0o600：密钥文件不给同组/其他用户读权限。
		writeJsonFile(this.filePath, data, 2, 0o600);
	}

	private decrypt(credential: Credential): Credential {
		if (credential.type === "api_key" && credential.key) {
			return { ...credential, key: decryptApiKey(credential.key) };
		}
		return credential;
	}

	private encrypt(credential: Credential): Credential {
		if (credential.type === "api_key" && credential.key) {
			return { ...credential, key: encryptApiKey(credential.key) };
		}
		return credential;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const data = this.readData();
		const credential = data[providerId];
		return credential ? this.decrypt(credential) : undefined;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this._withLock(async () => {
			const data = this.readData();
			const current = data[providerId];
			const decrypted = current ? this.decrypt(current) : undefined;
			const next = await fn(decrypted);
			// Align with pi-ai CredentialStore contract:
			//   - next !== undefined → write the new credential
			//   - next === undefined → leave the entry unchanged (no-op)
			// Deletion is a separate path via delete(providerId).
			if (next !== undefined) {
				data[providerId] = this.encrypt(next);
				this.writeData(data);
			}
			return next;
		});
	}

	async delete(providerId: string): Promise<void> {
		return this._withLock(async () => {
			const data = this.readData();
			delete data[providerId];
			this.writeData(data);
		});
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const data = this.readData();
		return Object.entries(data).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}
}

/**
 * Convenience: set or remove an API key in a CredentialStore.
 */
export async function setCredentialApiKey(store: CredentialStore, provider: string, key: string): Promise<void> {
	const trimmed = key.trim();
	if (trimmed) {
		await store.modify(provider, async () => ({ type: "api_key", key: trimmed }));
	} else {
		await store.delete(provider);
	}
}

/**
 * Convenience: get the stored API key from a CredentialStore.
 */
export async function getCredentialApiKey(store: CredentialStore, provider: string): Promise<string | undefined> {
	const credential = await store.read(provider);
	return credential?.type === "api_key" ? credential.key : undefined;
}
