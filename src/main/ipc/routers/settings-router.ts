// ============================================================
// Settings router — API keys, custom providers, general settings, prompts
// ============================================================

import { completeSimple, type ProviderResponse } from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiKey, getProviderSettings, setApiKey } from "../../models/model-queries.js";
import { testApiKey, testConfiguredProvider } from "../../models/validator.js";
import type { CustomProviderInput } from "../../settings/custom-providers.js";
import { toProviderConfig } from "../../settings/custom-providers.js";
import {
	guardBoolean,
	guardCustomProviderInput,
	guardEnum,
	guardNullableString,
	guardObject,
	guardProvider,
	guardString,
	guardStringArray,
} from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const settingsRouter: IpcRouter = (ctx, register) => {
	register("settings:get", async () => {
		const result = getProviderSettings(ctx.modelRegistry, ctx.customProviders);
		return { success: true, ...result };
	});

	register("settings:get-api-key", async (data) => {
		const _provider = guardProvider(data.provider);
		const key = await getApiKey(ctx.credentialStore, _provider);
		return { success: true, key: key ?? null };
	});

	register("settings:set-api-key", async (data) => {
		const _provider = guardProvider(data.provider);
		guardString(data.key, "key");
		await setApiKey(ctx.credentialStore, _provider, data.key);
		const result = getProviderSettings(ctx.modelRegistry, ctx.customProviders);
		return { success: true, ...result };
	});

	register("settings:test-api-key", async (data) => {
		const _provider = guardProvider(data.provider);
		guardString(data.key, "key");
		const result = await testApiKey(_provider, data.key);
		return { success: true, result };
	});

	register("settings:test-env-key", async (data) => {
		const _provider = guardProvider(data.provider);
		const result = await testConfiguredProvider(ctx.modelRegistry, _provider);
		return { success: true, result };
	});

	register("settings:add-custom-provider", async (data) => {
		const input = guardCustomProviderInput(data.payload, "payload") as unknown as CustomProviderInput;
		ctx.customProviders.add(input);
		return { success: true };
	});

	register("settings:update-custom-provider", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const name = guardString(payload.name, "payload.name");
		const patch = guardObject(payload.patch, "payload.patch") as Partial<CustomProviderInput>;
		ctx.customProviders.update(name, patch);
		return { success: true };
	});

	register("settings:remove-custom-provider", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const name = guardString(payload.name, "payload.name");
		return { success: true, removed: ctx.customProviders.remove(name) };
	});

	register("settings:list-custom-providers", async () => {
		return { success: true, providers: ctx.customProviders.list() };
	});

	register("settings:test-custom-provider", async (data) => {
		const input = guardCustomProviderInput(data.payload, "payload") as unknown as CustomProviderInput;
		const memCredentials = new InMemoryCredentialStore();
		if (input.apiKey) {
			await memCredentials.modify(input.name, async () => ({ type: "api_key" as const, key: input.apiKey }));
		}
		const memRuntime = await ModelRuntime.create({ credentials: memCredentials });
		const memRegistry = new ModelRegistry(memRuntime);
		try {
			memRuntime.registerProvider(input.name, toProviderConfig(input));
		} catch (e) {
			return {
				success: true,
				result: {
					overall: "fail",
					results: [{ modelId: "registration", ok: false, error: e instanceof Error ? e.message : String(e) }],
				},
			};
		}

		const results = await Promise.all(
			input.models.map(async (m) => {
				const start = Date.now();
				try {
					const model = memRegistry.find(input.name, m.id);
					if (!model) {
						return { modelId: m.id, ok: false, error: "model not found in in-memory registry" };
					}
					const auth = await memRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) {
						return { modelId: m.id, ok: false, error: `auth: ${auth.error}` };
					}
					let status = 0;
					const message = await completeSimple(
						model,
						{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							maxTokens: 1,
							timeoutMs: 10_000,
							maxRetries: 0,
							onResponse: (response: ProviderResponse) => {
								status = response.status;
							},
						},
					);
					if (message.stopReason === "error") {
						return { modelId: m.id, ok: false, error: message.errorMessage ?? `HTTP ${status}` };
					}
					return { modelId: m.id, ok: true, latencyMs: Date.now() - start };
				} catch (e) {
					return { modelId: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			}),
		);
		const overall = results.every((r) => r.ok) ? "ok" : "fail";
		return { success: true, result: { overall, results } };
	});

	register("settings:general:get", async () => {
		return { success: true, settings: ctx.runtimeManager.getGeneralSettings() };
	});

	register("settings:general:set", async (data) => {
		const settings = guardObject(data.settings, "settings");
		if ("language" in settings) {
			guardEnum(settings.language, "settings.language", ["en", "zh", "ja"] as const);
		}
		if ("autoCollapse" in settings) {
			guardBoolean(settings.autoCollapse, "settings.autoCollapse");
		}
		if ("compactionEnabled" in settings) {
			guardBoolean(settings.compactionEnabled, "settings.compactionEnabled");
		}
		if ("permissionMode" in settings) {
			guardEnum(settings.permissionMode, "settings.permissionMode", ["always", "ask", "plan"] as const);
		}
		if ("preferredModel" in settings && settings.preferredModel !== null) {
			guardString(settings.preferredModel, "settings.preferredModel");
		}
		if ("lastActiveSessionId" in settings) {
			guardString(settings.lastActiveSessionId, "settings.lastActiveSessionId");
		}
		if ("lastActiveProjectId" in settings) {
			guardString(settings.lastActiveProjectId, "settings.lastActiveProjectId");
		}
		if ("openProjectIds" in settings) {
			guardStringArray(settings.openProjectIds, "settings.openProjectIds");
		}
		if ("openedSessionIds" in settings) {
			guardStringArray(settings.openedSessionIds, "settings.openedSessionIds");
		}
		if ("themeTone" in settings) {
			guardEnum(settings.themeTone, "settings.themeTone", ["light", "dark"] as const);
		}
		if ("autoTitleModel" in settings) {
			guardNullableString(settings.autoTitleModel, "settings.autoTitleModel");
		}
		if ("subagentEnabled" in settings) {
			guardBoolean(settings.subagentEnabled, "settings.subagentEnabled");
		}
		if ("enabledAgentDefinitions" in settings) {
			if (settings.enabledAgentDefinitions !== null) {
				guardStringArray(settings.enabledAgentDefinitions, "settings.enabledAgentDefinitions");
			}
		}
		if ("enabledSkills" in settings) {
			if (settings.enabledSkills !== null) {
				guardStringArray(settings.enabledSkills, "settings.enabledSkills");
			}
		}
		if (typeof (data.settings as Record<string, unknown>)?.themeTone === "string") {
			const tone = (data.settings as Record<string, unknown>).themeTone;
			if (!ctx.mainWindow.isDestroyed()) {
				ctx.mainWindow.setBackgroundColor(tone === "light" ? "#fbfbfa" : "#030202");
			}
		}

		const updated = await ctx.runtimeManager.updateGeneralSettings(data.settings ?? {});

		return { success: true, settings: updated };
	});

	register("settings:general:reset", async () => {
		return { success: true, settings: await ctx.runtimeManager.resetGeneralSettings() };
	});

	register("settings:prompts:list", async () => {
		return { success: true, ...ctx.runtimeManager.promptStore.list() };
	});

	register("settings:prompts:create", async (data) => {
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.create(name, content);
		return { success: true, prompt };
	});

	register("settings:prompts:update", async (data) => {
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.update(id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		if (patch.content) {
			ctx.runtimeManager.promptStore.syncProjectOverridesForPrompt(id);
		}
		return { success: true, prompt };
	});

	register("settings:prompts:delete", async (data) => {
		const id = guardString(data.id, "id");
		const deleted = ctx.runtimeManager.promptStore.delete(id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		return { success: true };
	});

	register("settings:prompts:set-active", async (data) => {
		const id = guardString(data.id, "id");
		const ok = ctx.runtimeManager.promptStore.setActive(id);
		if (!ok) return { success: false, error: "Prompt not found" };
		return { success: true };
	});

	register("settings:project-prompts:list", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		return { success: true, ...ctx.runtimeManager.promptStore.listProjectPrompts(projectId) };
	});

	register("settings:project-prompts:create", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.createProjectPrompt(projectId, name, content);
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	});

	register("settings:project-prompts:update", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.updateProjectPrompt(projectId, id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	});

	register("settings:project-prompts:delete", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const deleted = ctx.runtimeManager.promptStore.deleteProjectPrompt(projectId, id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true };
	});

	register("settings:project-prompts:set-active", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const ok = ctx.runtimeManager.promptStore.setProjectActive(projectId, id);
		if (!ok) return { success: false, error: "Prompt not found" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true };
	});
};
