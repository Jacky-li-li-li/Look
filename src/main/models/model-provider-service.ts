// ============================================================
// ModelProviderService — model discovery, provider listing, API key management
//
// Extracted from SessionRuntimeManager as a stateless service that
// depends only on pi SDK's ModelRegistry, AuthStorage, and Look's
// CustomProvidersStore. No dependency on IEventBus or IRuntimeStore.
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

export class ModelProviderService {
	constructor(
		private readonly modelRegistry: ModelRegistry,
		private readonly authStorage: AuthStorage,
		private readonly customProvidersStore: CustomProvidersStore,
	) {}

	setApiKey(provider: string, key: string): void {
		const trimmed = key.trim();
		if (trimmed) this.authStorage.set(provider, { type: "api_key", key: trimmed });
		else this.authStorage.remove(provider);
	}

	getApiKey(provider: string): string | undefined {
		const credential = this.authStorage.get(provider);
		return credential?.type === "api_key" ? credential.key : undefined;
	}

	async testApiKey(provider: string, key: string) {
		const validator = await import("./validator.js");
		return validator.testApiKey(provider, key);
	}

	async testEnvKey(provider: string) {
		const validator = await import("./validator.js");
		return validator.testConfiguredProvider(this.modelRegistry, provider);
	}

	getAvailableModels(): AvailableModel[] {
		return this.modelRegistry.getAvailable().flatMap((model) => {
			const auth = this.modelRegistry.getProviderAuthStatus(model.provider);
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

	async getProviders(): Promise<ProviderInfo[]> {
		const providers = new Map<string, string>();
		for (const model of this.modelRegistry.getAll()) {
			providers.set(model.provider, this.modelRegistry.getProviderDisplayName(model.provider));
		}
		return Array.from(providers, ([id, name]) => ({
			id,
			name,
			hasCredentials: this.modelRegistry.getProviderAuthStatus(id).configured,
			models: this.modelRegistry.getAvailable().flatMap((model) => (model.provider === id ? [model.id] : [])),
		}));
	}

	async getProviderSettings(): Promise<ProviderSettingsResult> {
		const customList = this.customProvidersStore.list();
		const customNames = new Set(customList.map((p) => p.name));
		const providers = await this.getProviders();
		const filtered = providers.flatMap((provider) => {
			if (customNames.has(provider.id)) return [];
			const auth = this.modelRegistry.getProviderAuthStatus(provider.id);
			const models = this.getAvailableModels().filter((model) => model.provider === provider.id);
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
}
