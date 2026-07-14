// ============================================================
// Model queries — standalone functions for model discovery,
// provider listing, and API key management.
//
// These replace the ModelProviderService class. Callers pass pi SDK's
// ModelRegistry / AuthStorage / CustomProvidersStore directly instead
// of going through a stateful service layer.
// ============================================================

import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CustomProvidersStore } from "../settings/custom-providers.js";

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
}

export interface ProviderSetting {
	id: string;
	name: string;
	hasKey: boolean;
	envVar?: string;
	modelsAvailable: number;
	models: AvailableModel[];
	authSource?: string;
	envLabel?: string;
}

export interface ProviderSettingsResult {
	providers: ProviderSetting[];
	customStats: {
		configured: number;
		totalModels: number;
	};
}

/** Get all available models with configured auth credentials. */
export function getAvailableModels(modelRegistry: ModelRegistry): AvailableModel[] {
	return modelRegistry.getAvailable().flatMap((model) => {
		const auth = modelRegistry.getProviderAuthStatus(model.provider);
		if (auth.source === "environment") return [];
		if (!auth.configured) return [];
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
		hasCredentials: modelRegistry.getProviderAuthStatus(id).configured,
		models: modelRegistry.getAvailable().flatMap((model) => (model.provider === id ? [model.id] : [])),
	}));
}

/** Get settings-UI provider listing with custom provider stats. */
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
				envVar: auth.source === "environment" ? auth.label : undefined,
				modelsAvailable: models.length,
				models,
				authSource: auth.source,
				envLabel: auth.label,
			},
		];
	});

	const customConfigured = customList.filter((cp) => !!cp.apiKey).length;
	const customTotalModels = customList.reduce((sum, cp) => sum + cp.models.length, 0);

	return {
		providers: filtered,
		customStats: {
			configured: customConfigured,
			totalModels: customTotalModels,
		},
	};
}

/** Set or remove an API key for a provider. */
export function setApiKey(authStorage: AuthStorage, provider: string, key: string): void {
	const trimmed = key.trim();
	if (trimmed) authStorage.set(provider, { type: "api_key", key: trimmed });
	else authStorage.remove(provider);
}

/** Get the stored API key for a provider. */
export function getApiKey(authStorage: AuthStorage, provider: string): string | undefined {
	const credential = authStorage.get(provider);
	return credential?.type === "api_key" ? credential.key : undefined;
}
