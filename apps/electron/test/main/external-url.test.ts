import { describe, expect, it, vi } from "vitest";
import { classifyExternalUrl, openExternalWithPolicy } from "../../src/main/security/external-url.js";

describe("external url policy", () => {
	it("classifies protocols", () => {
		expect(classifyExternalUrl("https://example.com")).toBe("open");
		expect(classifyExternalUrl("http://example.com")).toBe("confirm");
		expect(classifyExternalUrl("file:///etc/passwd")).toBe("deny");
		expect(classifyExternalUrl("javascript:alert(1)")).toBe("deny");
		expect(classifyExternalUrl("not a url")).toBe("deny");
	});

	it("opens https without confirmation", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		const confirm = vi.fn();
		await expect(openExternalWithPolicy("https://a.com", { openExternal, confirm })).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("asks before http and respects cancel", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		await expect(
			openExternalWithPolicy("http://a.com", { openExternal, confirm: vi.fn().mockResolvedValue(false) }),
		).resolves.toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
		await expect(
			openExternalWithPolicy("http://a.com", { openExternal, confirm: vi.fn().mockResolvedValue(true) }),
		).resolves.toBe(true);
		expect(openExternal).toHaveBeenCalledWith("http://a.com");
	});

	it("never opens denied protocols", async () => {
		const openExternal = vi.fn();
		const confirm = vi.fn();
		await expect(openExternalWithPolicy("file:///x", { openExternal, confirm })).resolves.toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});
});
