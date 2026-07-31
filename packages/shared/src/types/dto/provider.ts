/** Custom provider model input (matches CustomProviderModelInput in custom-providers-store.ts) */
export interface CustomProviderModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	compat?: Record<string, unknown>;
}

/** Custom provider input (matches CustomProviderInput in custom-providers-store.ts) */
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

/** Per-model self-test result */
export interface ModelTestResult {
	modelId: string;
	ok: boolean;
	error?: string;
	latencyMs?: number;
}

/** Overall result of testing a custom provider's models */
export interface TestCustomProviderResult {
	overall: "ok" | "fail";
	results: ModelTestResult[];
}

/** Available model info (returned from ModelRegistry) */
export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
}

/** Provider info */
export interface ProviderInfo {
	id: string;
	name: string;
	hasCredentials: boolean;
	models: string[];
	supportsLogin: boolean;
}
