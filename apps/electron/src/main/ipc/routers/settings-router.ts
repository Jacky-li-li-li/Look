// ============================================================
// Settings router — API keys, custom providers, general settings, prompts
// ============================================================

import { LOOK_TONE_WINDOW_BG } from "@look/shared";
import { maskSecret } from "@look/shared/secret-mask";
import type { LookTone } from "@look/shared/types";
import { getApiKey, getProviderSettings, setApiKey } from "../../models/model-queries.js";
import { testApiKey, testConfiguredProvider, testCustomProvider } from "../../models/validator.js";
import type { CustomProviderInput } from "../../settings/custom-providers.js";
import { assertValid, toProviderConfig } from "../../settings/custom-providers.js";
import { OAuthLoginService } from "../../settings/oauth-login-service.js";
import { guardCustomProviderInput, guardObject, guardProvider, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { guardGeneralSettingsPatch } from "./settings-general-guards.js";

/**
 * 网络模型刷新的硬性超时。刷新内部每个 provider 的 fetchModels 可能
 * 无自身超时（代理/断网时挂死），这里统一用 AbortSignal 兜底，保证
 * 设置页操作与后台启动刷新都能 settle。
 */
const MODEL_NETWORK_REFRESH_TIMEOUT_MS = 30_000;

export const settingsRouter: IpcRouter = (ctx, register) => {
	// 有状态登录编排（pending prompt / 超时 / 窗口关闭拒绝）在服务内；
	// router 每次注册时随当前主窗口重建，与旧闭包实现生命周期一致。
	const oauthLogin = new OAuthLoginService({
		emit: (event) => ctx.session.notifier.emit(event),
		mainWindow: ctx.mainWindow,
	});

	register("settings:get", async () => {
		const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
		return { success: true, ...result };
	});

	register("settings:get-api-key", async (data) => {
		const _provider = guardProvider(data.provider);
		const key = await getApiKey(ctx.model.credentials, _provider);
		if (!key) {
			return { success: true, key: null, masked: false };
		}
		// 安全：默认只返回掩码给渲染进程，避免密钥明文常驻渲染侧（XSS/导航攻击面）。
		// 仅当用户显式点击"显示"时（reveal=true）才返回明文，用于查看/复制。
		// 前端编辑时若用户不改动掩码，则不覆盖原 key（见 ApiKeysTab）。
		if (data.reveal === true) {
			return { success: true, key, masked: false };
		}
		return { success: true, key: maskSecret(key), masked: true };
	});

	register("settings:set-api-key", async (data) => {
		const _provider = guardProvider(data.provider);
		guardString(data.key, "key");
		await setApiKey(ctx.model.credentials, _provider, data.key);
		// Trigger SDK model refresh so the provider's latest model list
		// (including newly released models) becomes available immediately.
		// 显式超时：网络刷新挂死（代理/断网）不能把 IPC 永久吊住。
		const refreshResult = await ctx.model.runtime.refresh({
			allowNetwork: true,
			signal: AbortSignal.timeout(MODEL_NETWORK_REFRESH_TIMEOUT_MS),
		});
		if (refreshResult.errors.size > 0) {
			console.warn("[Look] Model refresh after set-api-key had errors:", refreshResult.errors);
		}
		ctx.session.notifier.emit({ type: "model:updated" });
		const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
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
		const result = await testConfiguredProvider(ctx.model.runtime, _provider);
		return { success: true, result };
	});

	register("login:prompt-respond", async (data) => {
		const promptId = guardString(data.promptId, "promptId");
		const value = guardString(data.value, "value");
		oauthLogin.respond(promptId, value);
		return { success: true };
	});

	register("login:prompt-cancel", async (data) => {
		const promptId = guardString(data.promptId, "promptId");
		oauthLogin.cancel(promptId);
		return { success: true };
	});

	register("settings:provider-login", async (data) => {
		const _provider = guardProvider(data.provider);

		const outcome = await oauthLogin.loginWithInteraction(ctx.model.runtime, _provider);
		if (outcome.ok) {
			await ctx.model.runtime.refresh({
				allowNetwork: true,
				signal: AbortSignal.timeout(MODEL_NETWORK_REFRESH_TIMEOUT_MS),
			});
			ctx.session.notifier.emit({ type: "model:updated" });
			const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
			return { success: true, ...result };
		}
		if (outcome.cancelled) {
			const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
			// cancelled 必有错误文案（"Login cancelled"），兜底满足 IpcResult 的 error: string。
			return { success: false, ...result, error: outcome.error ?? "Login cancelled" };
		}
		return { success: false, error: outcome.error ?? "Login failed" };
	});

	register("settings:provider-logout", async (data) => {
		const _provider = guardProvider(data.provider);
		try {
			await ctx.model.runtime.logout(_provider);
			await ctx.model.runtime.refresh({
				allowNetwork: true,
				signal: AbortSignal.timeout(MODEL_NETWORK_REFRESH_TIMEOUT_MS),
			});
			ctx.session.notifier.emit({ type: "model:updated" });
			const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
			return { success: true, ...result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		}
	});

	register("settings:add-custom-provider", async (data) => {
		const input = guardCustomProviderInput(data.payload, "payload");
		ctx.model.customProviders.add(input);
		return { success: true };
	});

	register("settings:update-custom-provider", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const name = guardString(payload.name, "payload.name");
		const patch = guardObject(payload.patch, "payload.patch") as Partial<CustomProviderInput>;
		ctx.model.customProviders.update(name, patch);
		return { success: true };
	});

	register("settings:remove-custom-provider", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const name = guardString(payload.name, "payload.name");
		return { success: true, removed: ctx.model.customProviders.remove(name) };
	});

	register("settings:list-custom-providers", async () => {
		return { success: true, providers: ctx.model.customProviders.list() };
	});

	register("settings:test-custom-provider", async (data) => {
		const input = guardCustomProviderInput(data.payload, "payload");
		assertValid(input);
		const result = await testCustomProvider({
			name: input.name,
			apiKey: input.apiKey,
			models: input.models,
			providerConfig: toProviderConfig(input),
		});
		return { success: true, result };
	});

	register("settings:general:get", async () => {
		return { success: true, settings: ctx.session.settings.get() };
	});

	register("settings:general:set", async (data) => {
		const settings = guardObject(data.settings, "settings");
		guardGeneralSettingsPatch(settings);
		if ("themeTone" in settings && !ctx.mainWindow.isDestroyed()) {
			ctx.mainWindow.setBackgroundColor(LOOK_TONE_WINDOW_BG[settings.themeTone as LookTone] ?? "#030202");
		}
		const updated = await ctx.session.settings.update(settings);

		return { success: true, settings: updated };
	});

	register("settings:general:reset", async () => {
		return { success: true, settings: await ctx.session.settings.reset() };
	});

	register("settings:prompts:list", async () => {
		return { success: true, ...ctx.settings.prompts.list() };
	});

	register("settings:prompts:create", async (data) => {
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.settings.prompts.create(name, content);
		return { success: true, prompt };
	});

	register("settings:prompts:update", async (data) => {
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.settings.prompts.update(id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		if (patch.content) {
			ctx.settings.prompts.syncProjectOverridesForPrompt(id);
		}
		return { success: true, prompt };
	});

	register("settings:prompts:delete", async (data) => {
		const id = guardString(data.id, "id");
		const deleted = ctx.settings.prompts.delete(id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		return { success: true };
	});

	register("settings:prompts:set-active", async (data) => {
		const id = guardString(data.id, "id");
		const ok = ctx.settings.prompts.setActive(id);
		if (!ok) return { success: false, error: "Prompt not found" };
		return { success: true };
	});

	register("settings:project-prompts:list", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		return { success: true, ...ctx.settings.prompts.listProjectPrompts(projectId) };
	});

	register("settings:project-prompts:create", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.settings.prompts.createProjectPrompt(projectId, name, content);
		ctx.settings.prompts.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	});

	register("settings:project-prompts:update", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.settings.prompts.updateProjectPrompt(projectId, id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		ctx.settings.prompts.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	});

	register("settings:project-prompts:delete", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const deleted = ctx.settings.prompts.deleteProjectPrompt(projectId, id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		ctx.settings.prompts.syncProjectSystemFile(projectId);
		return { success: true };
	});

	register("settings:project-prompts:set-active", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const ok = ctx.settings.prompts.setProjectActive(projectId, id);
		if (!ok) return { success: false, error: "Prompt not found" };
		ctx.settings.prompts.syncProjectSystemFile(projectId);
		return { success: true };
	});
};
