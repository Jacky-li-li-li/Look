import { describe, expect, it } from "vitest";
import { ALLOWED_URL_PROTOCOLS, assertSafeUrl, normalizeNavigationUrl } from "../src/main/browser/url-policy";

describe("url-policy", () => {
	it("keeps http/https/about URLs as-is", () => {
		expect(normalizeNavigationUrl("https://example.com")).toBe("https://example.com");
		expect(normalizeNavigationUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
		expect(normalizeNavigationUrl("about:blank")).toBe("about:blank");
	});

	it("prepends http:// to bare domains and trims whitespace", () => {
		expect(normalizeNavigationUrl("example.com")).toBe("http://example.com");
		expect(normalizeNavigationUrl("  example.com/path  ")).toBe("http://example.com/path");
	});

	it("returns undefined for empty input", () => {
		expect(normalizeNavigationUrl(undefined)).toBeUndefined();
		expect(normalizeNavigationUrl("")).toBeUndefined();
		expect(normalizeNavigationUrl("   ")).toBeUndefined();
		expect(() => assertSafeUrl(undefined)).not.toThrow();
		expect(() => assertSafeUrl("   ")).not.toThrow();
	});

	it("rejects local/executable protocols", () => {
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,<script>1</script>",
			"chrome://version",
		]) {
			expect(() => normalizeNavigationUrl(url)).toThrow(/disallowed protocol/);
		}
	});

	it("matches the scheme case-insensitively", () => {
		expect(() => assertSafeUrl("FILE:///etc/passwd")).toThrow(/disallowed protocol/i);
		expect(() => assertSafeUrl("JavaScript:alert(1)")).toThrow(/disallowed protocol/i);
		expect(() => assertSafeUrl("HTTPS://example.com")).not.toThrow();
	});

	it("whitelists exactly http/https/about", () => {
		expect([...ALLOWED_URL_PROTOCOLS].sort()).toEqual(["about:", "http:", "https:"]);
	});
});
