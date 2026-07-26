import { describe, expect, it } from "vitest";
import { parseOAuthCallback } from "../src/renderer/lib/oauth-callback";

describe("parseOAuthCallback", () => {
	it("parses PKCE authorization code from the query string", () => {
		expect(parseOAuthCallback("look://auth/callback?code=abc123")).toEqual({
			type: "code",
			code: "abc123",
		});
	});

	it("parses implicit-flow tokens from the hash fragment", () => {
		expect(parseOAuthCallback("look://auth/callback#access_token=at&refresh_token=rt&expires_in=3600")).toEqual({
			type: "tokens",
			accessToken: "at",
			refreshToken: "rt",
		});
	});

	it("returns no-credentials when the callback carries neither code nor tokens", () => {
		expect(parseOAuthCallback("look://auth/callback")).toEqual({ type: "error", error: "no-credentials" });
		expect(parseOAuthCallback("look://auth/callback?theme=dark#")).toEqual({
			type: "error",
			error: "no-credentials",
		});
	});

	it("requires both access and refresh tokens", () => {
		expect(parseOAuthCallback("look://auth/callback#access_token=at")).toEqual({
			type: "error",
			error: "no-credentials",
		});
	});

	it("surfaces provider errors from query or fragment", () => {
		expect(parseOAuthCallback("look://auth/callback?error=access_denied&error_description=denied")).toEqual({
			type: "error",
			error: "denied",
		});
		expect(parseOAuthCallback("look://auth/callback#error=server_error")).toEqual({
			type: "error",
			error: "server_error",
		});
	});

	it("rejects unparseable URLs", () => {
		expect(parseOAuthCallback("not a url")).toEqual({ type: "error", error: "invalid-url" });
	});
});
