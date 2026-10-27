import fs from "node:fs";
import path from "node:path";
import {
	getAuthPath,
	getModelsPath,
	getSettingsPath,
	getWorkspaceSessionsDir,
	getWorkspaceSubsessionsDir,
	getWorkspacesDir,
} from "@look/shared/look-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
	migrateAzureProviderId,
	migrateAzureProviderInSessionFile,
	remapSessionEntryProvider,
} from "../src/main/settings/migrate-azure-provider";

function wipe(filePath: string): void {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

afterEach(() => {
	wipe(getAuthPath());
	wipe(getModelsPath());
	wipe(getSettingsPath());
	const workspaces = getWorkspacesDir();
	if (fs.existsSync(workspaces)) fs.rmSync(workspaces, { recursive: true, force: true });
});

describe("migrateAzureProviderId", () => {
	it("renames auth/models/settings azure-openai-responses → azure", () => {
		fs.writeFileSync(
			getAuthPath(),
			JSON.stringify({ "azure-openai-responses": { type: "api_key", key: "sk-test" } }, null, 2),
		);
		fs.writeFileSync(
			getModelsPath(),
			JSON.stringify(
				{
					providers: {
						"azure-openai-responses": {
							baseUrl: "https://example.openai.azure.com",
							api: "azure-openai-responses",
							models: [],
						},
					},
				},
				null,
				2,
			),
		);
		fs.writeFileSync(
			getSettingsPath(),
			JSON.stringify(
				{
					defaultProvider: "azure-openai-responses",
					defaultModel: "gpt-5.4",
					enabledModels: ["azure-openai-responses/*", "anthropic/*"],
					modelThinkingLevels: {
						"azure-openai-responses/gpt-5.4": "high",
						"anthropic/claude-opus-4-8": "medium",
					},
				},
				null,
				2,
			),
		);

		const result = migrateAzureProviderId();
		expect(result.migrated).toBe(true);
		expect(result.keys.length).toBeGreaterThanOrEqual(3);

		const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
		expect(auth.azure).toEqual({ type: "api_key", key: "sk-test" });
		expect(auth["azure-openai-responses"]).toBeUndefined();

		const models = JSON.parse(fs.readFileSync(getModelsPath(), "utf-8"));
		expect(models.providers.azure).toBeDefined();
		expect(models.providers["azure-openai-responses"]).toBeUndefined();
		// Nested api is an API type, not a provider id — must stay.
		expect(models.providers.azure.api).toBe("azure-openai-responses");

		const settings = JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
		expect(settings.defaultProvider).toBe("azure");
		expect(settings.enabledModels).toEqual(["azure/*", "anthropic/*"]);
		expect(settings.modelThinkingLevels).toEqual({
			"azure/gpt-5.4": "high",
			"anthropic/claude-opus-4-8": "medium",
		});
	});

	it("is a no-op when already on azure id", () => {
		fs.writeFileSync(getAuthPath(), JSON.stringify({ azure: { type: "api_key", key: "sk" } }, null, 2));
		const result = migrateAzureProviderId();
		expect(result.migrated).toBe(false);
		expect(result.keys).toEqual([]);
	});

	it("does not overwrite an existing azure auth key", () => {
		fs.writeFileSync(
			getAuthPath(),
			JSON.stringify(
				{
					azure: { type: "api_key", key: "keep-me" },
					"azure-openai-responses": { type: "api_key", key: "old" },
				},
				null,
				2,
			),
		);
		const result = migrateAzureProviderId();
		expect(result.migrated).toBe(true);
		const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
		expect(auth.azure).toEqual({ type: "api_key", key: "keep-me" });
		expect(auth["azure-openai-responses"]).toBeUndefined();
	});

	it("remaps old session metadata provider azure-openai-responses → azure", () => {
		const projectId = "proj-azure-session";
		const sessionsDir = getWorkspaceSessionsDir(projectId);
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = path.join(sessionsDir, "old-azure.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "sess-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		};
		const modelChange = {
			type: "model_change",
			id: "mc-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			provider: "azure-openai-responses",
			modelId: "gpt-5.4",
		};
		const usage = {
			type: "usage",
			id: "u-1",
			parentId: "mc-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			kind: "cache_warm",
			provider: "azure-openai-responses",
			model: "gpt-5.4",
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
		};
		const alreadyAzure = {
			type: "model_change",
			id: "mc-2",
			parentId: "u-1",
			timestamp: "2026-01-01T00:00:03.000Z",
			provider: "azure",
			modelId: "gpt-5.4",
		};
		const otherProvider = {
			type: "model_change",
			id: "mc-3",
			parentId: "mc-2",
			timestamp: "2026-01-01T00:00:04.000Z",
			provider: "anthropic",
			modelId: "claude-opus-4-8",
		};
		// Nested api must not be rewritten if somehow present on an entry payload.
		const customWithApi = {
			type: "custom",
			id: "c-1",
			parentId: "mc-3",
			timestamp: "2026-01-01T00:00:05.000Z",
			customType: "look.test",
			data: { api: "azure-openai-responses", provider: "azure-openai-responses" },
		};
		fs.writeFileSync(
			sessionPath,
			`${[header, modelChange, usage, alreadyAzure, otherProvider, customWithApi]
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);

		const subDir = getWorkspaceSubsessionsDir(projectId);
		fs.mkdirSync(subDir, { recursive: true });
		const subPath = path.join(subDir, "child.jsonl");
		fs.writeFileSync(
			subPath,
			`${JSON.stringify({
				type: "model_change",
				id: "mc-child",
				parentId: null,
				timestamp: "2026-01-01T00:00:06.000Z",
				provider: "azure-openai-responses",
				modelId: "gpt-5.4",
			})}\n`,
		);

		const result = migrateAzureProviderId();
		expect(result.migrated).toBe(true);
		expect(result.keys.some((k) => k.includes("session jsonl"))).toBe(true);

		const lines = fs
			.readFileSync(sessionPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[1]).toMatchObject({ type: "model_change", provider: "azure", modelId: "gpt-5.4" });
		expect(lines[2]).toMatchObject({ type: "usage", provider: "azure" });
		expect(lines[3]).toMatchObject({ type: "model_change", provider: "azure" });
		expect(lines[4]).toMatchObject({ type: "model_change", provider: "anthropic" });
		// custom entry top-level provider is not a SessionManager model_change/usage field —
		// leave nested payloads alone (including nested api AND nested provider inside data).
		expect(lines[5].data).toEqual({
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
		});

		const child = JSON.parse(fs.readFileSync(subPath, "utf-8").trim());
		expect(child.provider).toBe("azure");

		// Idempotent: second pass is a no-op for sessions.
		const second = migrateAzureProviderId();
		expect(second.keys.some((k) => k.includes("session jsonl"))).toBe(false);
	});
});

describe("remapSessionEntryProvider", () => {
	it("remaps model_change and usage only; leaves api and non-azure alone", () => {
		const oldModel = {
			type: "model_change",
			provider: "azure-openai-responses",
			modelId: "gpt-5.4",
		};
		expect(remapSessionEntryProvider(oldModel)).toBe(true);
		expect(oldModel.provider).toBe("azure");

		const azureAlready = { type: "model_change", provider: "azure", modelId: "x" };
		expect(remapSessionEntryProvider(azureAlready)).toBe(false);
		expect(azureAlready.provider).toBe("azure");

		const other = { type: "model_change", provider: "openai", modelId: "x" };
		expect(remapSessionEntryProvider(other)).toBe(false);
		expect(other.provider).toBe("openai");

		const withApi = {
			type: "model_change",
			provider: "azure-openai-responses",
			api: "azure-openai-responses",
			modelId: "gpt-5.4",
		};
		expect(remapSessionEntryProvider(withApi)).toBe(true);
		expect(withApi.provider).toBe("azure");
		expect(withApi.api).toBe("azure-openai-responses");
	});

	it("migrateAzureProviderInSessionFile is a no-op without old provider id", () => {
		const dir = getWorkspaceSessionsDir("noop-proj");
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "clean.jsonl");
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({ type: "model_change", provider: "azure", modelId: "gpt-5.4" })}\n`,
		);
		expect(migrateAzureProviderInSessionFile(filePath)).toBe(false);
	});
});
