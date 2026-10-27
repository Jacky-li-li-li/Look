import fs from "node:fs";
import { getAuthPath, getModelsPath, getSettingsPath } from "@look/shared/look-storage";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAzureProviderId } from "../src/main/settings/migrate-azure-provider";

function wipe(filePath: string): void {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

afterEach(() => {
	wipe(getAuthPath());
	wipe(getModelsPath());
	wipe(getSettingsPath());
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
});
