// ============================================================
// settings/types.ts — Shared types for settings tabs
// ============================================================

export interface ProviderModelInfo {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface ProviderInfo {
	id: string;
	name: string;
	hasKey: boolean;
	envVar?: string;
	modelsAvailable: number;
	models?: ProviderModelInfo[];
	authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	envLabel?: string;
}

export type TestVerdict = { verdict: "ok" | "error" | "skipped"; reason?: string } | null;
