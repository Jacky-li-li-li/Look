import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorage = {
	isEncryptionAvailable: vi.fn(() => false),
	getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
	encryptString: vi.fn((s: string) => Buffer.from(`x${s}`)),
	decryptString: vi.fn((b: Buffer) => b.toString().slice(1)),
};
vi.mock("electron", () => ({ safeStorage }));

const status = await import("../../src/main/security/secret-storage-status.js");
const secrets = await import("../../src/main/security/secrets.js");
const im = await import("../../src/main/im/im-storage.js");

const realPlatform = process.platform;
function setPlatform(p: string) {
	Object.defineProperty(process, "platform", { value: p });
}

beforeEach(() => {
	status.resetSecretStorageStatusForTest();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	setPlatform(realPlatform);
	vi.restoreAllMocks();
});

describe("secret storage plaintext fallback tracking", () => {
	it("encryptApiKey records plaintext fallback when safeStorage unavailable (backward compatible: still stores)", () => {
		safeStorage.isEncryptionAvailable.mockReturnValue(false);
		expect(secrets.encryptApiKey("sk-1")).toBe("sk-1");
		expect(status.getSecretStorageStatus()).toMatchObject({ secure: false, plaintextFallbackUsed: true });
	});

	it("IM encryptSecret records plaintext fallback", () => {
		safeStorage.isEncryptionAvailable.mockReturnValue(false);
		expect(im.encryptSecret("s")).toEqual({ plain: "s" });
		expect(status.getSecretStorageStatus().plaintextFallbackUsed).toBe(true);
	});

	it("encrypted path is secure and records no fallback", () => {
		safeStorage.isEncryptionAvailable.mockReturnValue(true);
		setPlatform("darwin");
		expect(secrets.encryptApiKey("sk-1").startsWith("enc:")).toBe(true);
		expect(status.getSecretStorageStatus()).toEqual({ secure: true, backend: null, plaintextFallbackUsed: false });
	});

	it("Linux basic_text backend is reported as not secure", () => {
		safeStorage.isEncryptionAvailable.mockReturnValue(true);
		safeStorage.getSelectedStorageBackend.mockReturnValue("basic_text");
		setPlatform("linux");
		expect(status.getSecretStorageStatus()).toMatchObject({ secure: false, backend: "basic_text" });
		safeStorage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
		expect(status.getSecretStorageStatus().secure).toBe(true);
	});
});
