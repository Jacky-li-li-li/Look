// ============================================================
// provider-form-state — shared types & helpers for Provider form
// ============================================================

import type { CustomProviderInput, CustomProviderModelInput } from "./types";

export type ApiProtocol = CustomProviderInput["api"];

export interface ProviderCompatState {
	supportsDeveloperRole: boolean;
	supportsReasoningEffort: boolean;
	forceAdaptiveThinking: boolean;
	supportsEagerToolInputStreaming: boolean;
	allowEmptySignature: boolean;
}

export interface ProviderFormState {
	api: ApiProtocol;
	name: string;
	baseUrl: string;
	apiKey: string;
	showKey: boolean;
	headers: Array<{ id: number; key: string; value: string }>;
	headersOpen: boolean;
	models: Array<CustomProviderModelInput & { _key: number }>;
	compat: ProviderCompatState;
}

export interface ProviderFormErrors {
	name?: boolean;
	baseUrl?: boolean;
	apiKey?: boolean;
}

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"openai-responses": "OpenAI Responses",
};

export const API_PROTOCOLS: readonly ApiProtocol[] = [
	"openai-completions",
	"anthropic-messages",
	"google-generative-ai",
	"openai-responses",
];

export function normalizeApiProtocol(value: unknown, fallback: ApiProtocol = "openai-completions"): ApiProtocol {
	return typeof value === "string" && (API_PROTOCOLS as readonly string[]).includes(value)
		? (value as ApiProtocol)
		: fallback;
}

export function buildInitialForm(initial?: CustomProviderInput): ProviderFormState {
	return {
		api: normalizeApiProtocol(initial?.api),
		name: initial?.name ?? "",
		baseUrl: initial?.baseUrl ?? "",
		apiKey: initial?.apiKey ?? "",
		showKey: false,
		headers: initial?.headers
			? Object.entries(initial.headers).map(([k, v], i) => ({ id: i + 1, key: k, value: v }))
			: [],
		headersOpen: false,
		models: initial?.models.map((m, i) => ({ ...m, _key: i + 1 })) ?? [],
		compat: {
			supportsDeveloperRole: initial?.compat?.supportsDeveloperRole !== false,
			supportsReasoningEffort: initial?.compat?.supportsReasoningEffort !== false,
			forceAdaptiveThinking: !!initial?.compat?.forceAdaptiveThinking,
			supportsEagerToolInputStreaming: initial?.compat?.supportsEagerToolInputStreaming !== false,
			allowEmptySignature: !!initial?.compat?.allowEmptySignature,
		},
	};
}
