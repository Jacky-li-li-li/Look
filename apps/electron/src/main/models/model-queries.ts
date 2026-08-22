// ============================================================
// Model queries — standalone functions for model discovery,
// provider listing, and API key management.
//
// These replace the ModelProviderService class. Callers pass pi SDK's
// ModelRegistry / ModelRuntime / CustomProvidersStore directly instead
// of going through a stateful service layer.
// ============================================================

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getCredentialApiKey, setCredentialApiKey } from "../security/secrets.js";
import type { CustomProviderInput, CustomProvidersStore } from "../settings/custom-providers.js";

export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
}

export interface ProviderInfo {
	id: string;
	name: string;
	hasCredentials: boolean;
	models: string[];
	supportsLogin: boolean;
}

export interface ProviderSetting {
	id: string;
	name: string;
	hasKey: boolean;
	envVar?: string;
	modelsAvailable: number;
	models: AvailableModel[];
	authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	envLabel?: string;
	hasLogin: boolean;
	supportsApiKey: boolean;
}

export interface ProviderSettingsResult {
	providers: ProviderSetting[];
	customProviders: CustomProviderInput[];
	customStats: {
		configured: number;
		totalModels: number;
	};
}

/**
 * 判断 provider 凭据是否有效。
 *
 * 已启用环境变量凭据：pi-ai 在 shell env 中检测到 API key（如 ANTHROPIC_API_KEY，
 * 由 shell-env.ts 启动时从 rc 文件非破坏性合并进 process.env）时，auth 返回
 * { configured: true, source: "environment", label: "<ENV 变量名>" }。这里将其视为
 * 有效配置，与 pi CLI 的内置 provider 自动识别行为一致。来源由 UI 徽标展示
 * （"环境变量" + 变量名 title），用户可据此区分 key 来自环境变量还是 Look 存储。
 */
function isUsableCredential(auth: { configured: boolean; source?: string }): boolean {
	return auth.configured;
}

/** Get all available models with configured auth credentials. */
export function getAvailableModels(modelRegistry: ModelRegistry): AvailableModel[] {
	return modelRegistry.getAvailable().flatMap((model) => {
		const auth = modelRegistry.getProviderAuthStatus(model.provider);
		// 环境变量来源暂不作为可用凭据（功能未启用）。
		if (!isUsableCredential(auth)) return [];
		return [
			{
				provider: model.provider,
				id: model.id,
				name: model.name ?? model.id,
				reasoning: model.reasoning ?? false,
				contextWindow: model.contextWindow ?? 128000,
				maxTokens: model.maxTokens ?? 16384,
				cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
			},
		];
	});
}

/** Get provider metadata (display name, auth status, model IDs). */
export function getProviders(modelRegistry: ModelRegistry): ProviderInfo[] {
	const providers = new Map<string, string>();
	for (const model of modelRegistry.getAll()) {
		providers.set(model.provider, modelRegistry.getProviderDisplayName(model.provider));
	}
	return Array.from(providers, ([id, name]) => ({
		id,
		name,
		hasCredentials: isUsableCredential(modelRegistry.getProviderAuthStatus(id)),
		models: modelRegistry.getAvailable().flatMap((model) => (model.provider === id ? [model.id] : [])),
		supportsLogin: providerSupportsLogin(id, modelRegistry),
	}));
}

/** Get settings-UI provider listing with custom provider stats. */
/**
 * Check whether a provider offers an OAuth-based interactive login flow.
 *
 * Providers with auth.oauth: anthropic, github-copilot, kimi-coding,
 * openai-codex, openrouter, radius, xai.
 */
function providerSupportsLogin(providerId: string, modelRegistry: ModelRegistry): boolean {
	// Check extension-registered native providers
	const nativeProvider = modelRegistry.getRegisteredNativeProvider(providerId);
	if (nativeProvider?.auth?.oauth) return true;
	// Check config-registered providers
	const config = modelRegistry.getRegisteredProviderConfig(providerId);
	if (config?.oauth) return true;
	// Check all providers via getProvider() (covers built-in pi providers)
	const allProvider = modelRegistry.getProvider(providerId);
	if (allProvider?.auth?.oauth) return true;
	return false;
}

export function getProviderSettings(
	modelRegistry: ModelRegistry,
	customProvidersStore: CustomProvidersStore,
): ProviderSettingsResult {
	const customList = customProvidersStore.list();
	const customNames = new Set(customList.map((p) => p.name));
	const allProviders = getProviders(modelRegistry);
	const filtered = allProviders.flatMap((provider) => {
		if (customNames.has(provider.id)) return [];
		const auth = modelRegistry.getProviderAuthStatus(provider.id);
		const models = getAvailableModels(modelRegistry).filter((model) => model.provider === provider.id);
		return [
			{
				id: provider.id,
				name: provider.name,
				hasKey: provider.hasCredentials,
				// 环境变量来源的 provider：透出 env 变量名（auth.label）供 UI 展示
				// "export <ENV>=..." 提示与徽标 title。
				envVar: auth.source === "environment" ? auth.label : undefined,
				modelsAvailable: models.length,
				models,
				authSource: auth.source,
				envLabel: auth.label,
				hasLogin: providerSupportsLogin(provider.id, modelRegistry),
				supportsApiKey: !!modelRegistry.getProvider(provider.id)?.auth?.apiKey,
			},
		];
	});

	const customConfigured = customList.filter((cp) => !!cp.apiKey).length;
	const customTotalModels = customList.reduce((sum, cp) => sum + cp.models.length, 0);

	return {
		providers: filtered,
		customProviders: customList,
		customStats: {
			configured: customConfigured,
			totalModels: customTotalModels,
		},
	};
}

/** Set or remove an API key for a provider via CredentialStore. */
export function setApiKey(credentialStore: CredentialStore, provider: string, key: string): Promise<void> {
	return setCredentialApiKey(credentialStore, provider, key);
}

/** Get the stored API key for a provider from CredentialStore. */
export function getApiKey(credentialStore: CredentialStore, provider: string): Promise<string | undefined> {
	return getCredentialApiKey(credentialStore, provider);
}
