// ============================================================
// Settings router — API keys, custom providers, general settings, prompts
// ============================================================

import type { ProviderResponse } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { LOOK_TONE_VALUES, LOOK_TONE_WINDOW_BG } from "@look/shared";
import { maskSecret } from "@look/shared/secret-mask";
import type { LookTone } from "@look/shared/types";
import { getApiKey, getProviderSettings, setApiKey } from "../../models/model-queries.js";
import { testApiKey, testConfiguredProvider } from "../../models/validator.js";
import type { CustomProviderInput } from "../../settings/custom-providers.js";
import { assertValid, toProviderConfig } from "../../settings/custom-providers.js";
import {
	guardBoolean,
	guardCustomProviderInput,
	guardEnum,
	guardNullableString,
	guardNumber,
	guardObject,
	guardProvider,
	guardString,
	guardStringArray,
} from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/**
 * 网络模型刷新的硬性超时。刷新内部每个 provider 的 fetchModels 可能
 * 无自身超时（代理/断网时挂死），这里统一用 AbortSignal 兜底，保证
 * 设置页操作与后台启动刷新都能 settle。
 */
const MODEL_NETWORK_REFRESH_TIMEOUT_MS = 30_000;

export const settingsRouter: IpcRouter = (ctx, register) => {
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

	// Track pending OAuth prompts that need renderer interaction.
	const pendingPrompts = new Map<
		string,
		{ resolve: (value: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	/** 渲染端崩溃/未响应时 prompt 的最大等待时间，超时 reject 避免主进程永久挂起。 */
	const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

	// 窗口关闭（渲染端崩溃/退出）时拒绝所有 pending prompt，避免主进程泄漏。
	ctx.mainWindow.once("closed", () => {
		for (const [, pending] of pendingPrompts) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Renderer window closed"));
		}
		pendingPrompts.clear();
	});

	register("login:prompt-respond", async (data) => {
		const promptId = guardString(data.promptId, "promptId");
		const value = guardString(data.value, "value");
		const pending = pendingPrompts.get(promptId);
		if (pending) {
			pendingPrompts.delete(promptId);
			clearTimeout(pending.timer);
			pending.resolve(value);
		}
		return { success: true };
	});

	register("login:prompt-cancel", async (data) => {
		const promptId = guardString(data.promptId, "promptId");
		const pending = pendingPrompts.get(promptId);
		if (pending) {
			pendingPrompts.delete(promptId);
			clearTimeout(pending.timer);
			pending.reject(new Error("Login cancelled"));
		}
		return { success: true };
	});

	register("settings:provider-login", async (data) => {
		const _provider = guardProvider(data.provider);

		const providerObj = ctx.model.runtime.getProvider(_provider);
		const providerName = providerObj?.name ?? _provider;

		if (!providerObj?.auth?.oauth) {
			return {
				success: false,
				error: `${providerName} does not support OAuth login`,
			};
		}

		const interaction: import("@earendil-works/pi-ai").AuthInteraction = {
			signal: undefined,
			prompt: async (prompt) => {
				const promptId = crypto.randomUUID();
				const promptEvent: import("@look/shared/types").MainToRendererEvent = {
					type: "login:prompt",
					providerId: _provider,
					promptId,
					prompt:
						prompt.type === "select"
							? { type: "select", message: prompt.message, options: [...prompt.options] }
							: prompt.type === "manual_code"
								? { type: "manual_code", message: prompt.message, placeholder: prompt.placeholder }
								: { type: "info", message: prompt.message },
				};
				ctx.session.notifier.emit(promptEvent);

				return new Promise<string>((resolve, reject) => {
					// 超时兜底：渲染端崩溃 / 用户长期不响应时 reject，
					// 否则 pendingPrompts 永久挂起导致 runtime.login() 泄漏。
					const timer = setTimeout(() => {
						pendingPrompts.delete(promptId);
						reject(new Error("Login prompt timed out"));
					}, PROMPT_TIMEOUT_MS);
					timer.unref?.();
					pendingPrompts.set(promptId, { resolve, reject, timer });
				});
			},
			notify: (event) => {
				if (event.type === "auth_url") {
					ctx.session.notifier.emit({
						type: "login:prompt",
						providerId: _provider,
						promptId: crypto.randomUUID(),
						prompt: { type: "auth_url", url: event.url, instructions: event.instructions },
					});
				} else if (event.type === "device_code") {
					ctx.session.notifier.emit({
						type: "login:prompt",
						providerId: _provider,
						promptId: crypto.randomUUID(),
						prompt: {
							type: "device_code",
							userCode: event.userCode,
							verificationUri: event.verificationUri,
						},
					});
				} else if (event.type === "progress" || event.type === "info") {
					ctx.session.notifier.emit({
						type: "login:prompt",
						providerId: _provider,
						promptId: crypto.randomUUID(),
						prompt: { type: "progress", message: event.message },
					});
				}
			},
		};

		try {
			await ctx.model.runtime.login(_provider, "oauth", interaction);
			ctx.session.notifier.emit({
				type: "login:completed",
				providerId: _provider,
				success: true,
			});
			await ctx.model.runtime.refresh({
				allowNetwork: true,
				signal: AbortSignal.timeout(MODEL_NETWORK_REFRESH_TIMEOUT_MS),
			});
			ctx.session.notifier.emit({ type: "model:updated" });
			const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
			return { success: true, ...result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.session.notifier.emit({
				type: "login:completed",
				providerId: _provider,
				success: false,
				error: message,
			});
			if (message === "Login cancelled") {
				const result = getProviderSettings(ctx.model.registry, ctx.model.customProviders);
				return { success: false, ...result, error: message };
			}
			return { success: false, error: message };
		}
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
		const memCredentials = new InMemoryCredentialStore();
		if (input.apiKey) {
			await memCredentials.modify(input.name, async () => ({ type: "api_key" as const, key: input.apiKey }));
		}
		const memRuntime = await ModelRuntime.create({ credentials: memCredentials });
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
					const model = memRuntime.getModel(input.name, m.id);
					if (!model) {
						return { modelId: m.id, ok: false, error: "model not found in in-memory registry" };
					}
					let status = 0;
					const message = await memRuntime.completeSimple(
						model,
						{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
						{
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
		return { success: true, settings: ctx.session.settings.get() };
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
			guardEnum(settings.themeTone, "settings.themeTone", LOOK_TONE_VALUES);
		}
		if ("autoTitleModel" in settings) {
			guardNullableString(settings.autoTitleModel, "settings.autoTitleModel");
		}
		if ("planModel" in settings) {
			guardNullableString(settings.planModel, "settings.planModel");
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
		if ("aiAvatar" in settings) {
			guardNullableString(settings.aiAvatar, "settings.aiAvatar");
		}
		if ("sidebarCollapsed" in settings) {
			guardBoolean(settings.sidebarCollapsed, "settings.sidebarCollapsed");
		}
		if ("rightPanelCollapsed" in settings) {
			guardBoolean(settings.rightPanelCollapsed, "settings.rightPanelCollapsed");
		}
		if ("rightPanelWidth" in settings) {
			guardNumber(settings.rightPanelWidth, "settings.rightPanelWidth", { min: 200, max: 480 });
		}
		if ("dockPanelWidth" in settings) {
			guardNumber(settings.dockPanelWidth, "settings.dockPanelWidth", { min: 320, max: 720 });
		}
		if ("desktopNotifications" in settings) {
			guardEnum(settings.desktopNotifications, "settings.desktopNotifications", [
				"off",
				"needs-action",
				"all",
			] as const);
		}
		if ("messageAlignment" in settings) {
			guardEnum(settings.messageAlignment, "settings.messageAlignment", ["left", "left-right"] as const);
		}
		if ("showToolExecution" in settings) {
			guardBoolean(settings.showToolExecution, "settings.showToolExecution");
		}
		if ("builtinBrowserEnabled" in settings) {
			guardBoolean(settings.builtinBrowserEnabled, "settings.builtinBrowserEnabled");
		}
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
