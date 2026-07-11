// ============================================================
// Secrets — safeStorage-backed API key encryption/decryption
//
// Uses Electron's safeStorage (OS keychain) to protect API keys
// stored in auth.json and custom-providers.json. Mirrors the
// pattern established in im-storage.ts for IM appSecret storage.
// ============================================================

import { safeStorage } from "electron";

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

export function wrapAuthStorage<T extends object>(inner: T): T {
	return new Proxy(inner, {
		get(target, prop: string | symbol) {
			if (prop === "get") {
				return (provider: string) => {
					const getFn = (target as Record<string | symbol, unknown>).get as (
						provider: string,
					) => Record<string, unknown> | undefined;
					const credential = getFn.call(target, provider);
					if (
						credential &&
						credential.type === "api_key" &&
						credential.key &&
						typeof credential.key === "string"
					) {
						return { ...credential, key: decryptApiKey(credential.key) };
					}
					return credential;
				};
			}
			if (prop === "set") {
				return (provider: string, credential: Record<string, unknown>) => {
					const setFn = (target as Record<string | symbol, unknown>).set as (
						provider: string,
						credential: Record<string, unknown>,
					) => void;
					if (credential.type === "api_key" && credential.key && typeof credential.key === "string") {
						setFn.call(target, provider, { ...credential, key: encryptApiKey(credential.key) });
					} else {
						setFn.call(target, provider, credential);
					}
				};
			}
			const value = (target as Record<string | symbol, unknown>)[prop];
			if (typeof value === "function") {
				return (value as (...args: unknown[]) => unknown).bind(target);
			}
			return value;
		},
	}) as T;
}
