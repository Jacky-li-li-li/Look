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
	hasLogin: boolean;
	supportsApiKey: boolean;
}

export type TestVerdict = { verdict: "ok" | "error" | "skipped"; reason?: string } | null;

// ── Custom provider types (mirrors packages/shared/src/types.ts) ──

export interface CustomProviderModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
}

export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	api: "openai-completions" | "anthropic-messages" | "google-generative-ai" | "openai-responses";
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: CustomProviderModelInput[];
	compat?: Record<string, unknown>;
}

export interface ModelTestResult {
	modelId: string;
	ok: boolean;
	error?: string;
	latencyMs?: number;
}

export interface TestCustomProviderResult {
	overall: "ok" | "fail";
	results: ModelTestResult[];
}

export interface CustomProviderStats {
	configured: number;
	totalModels: number;
}

// ── IM channel types ──

export interface ImChannelInfo {
	provider: string;
	appId: string;
	name?: string;
	status: "connected" | "disconnected" | "connecting" | "error";
	connected: boolean;
	enabled: boolean;
	error?: string;
}

export interface FeishuConnectOptions {
	appName?: string;
	description?: string;
}
