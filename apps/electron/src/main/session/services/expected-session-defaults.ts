// ============================================================
// ExpectedSessionDefaults — 新建会话草稿行的「预期」模型/思考投影
//
// 草稿行在 runtime 绑定前就要展示模型/思考信息。这里同步复算 pi
// findInitialModel 的解析序，保证草稿值 == 绑定后的真实值，否则初始
// 化完成时模型/思考选择器会整行跳变：
//   1. 当前项目 SettingsManager 的合并默认模型（project > global）——且必须
//      hasConfiguredAuth，凭据缺失时 pi 会跳过它；无项目上下文时使用全局设置；
//   2. pi 的 provider 默认模型表中第一个命中的可用模型；若无命中，取
//      首个可用模型（与 Look ensureSessionModel 兜底同源）。
// 思考级别：pi 初始值为 DEFAULT_THINKING_LEVEL（"medium"），仅在默认
// 模型路径上应用 settings 的 defaultThinkingLevel；级别表按模型裁剪
// （getSupportedThinkingLevels：xhigh/max 仅显式映射的模型才有），
// 越级值用 clampThinkingLevel 就近收敛。
// ============================================================

import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@look/shared/types";

/** 新建会话草稿行的「预期」模型/思考投影（runtime 绑定前的占位真值）。 */
export interface ExpectedSessionDefaults {
	model: string;
	thinkingLevel: ThinkingLevel;
	modelSupportsThinking: boolean;
	availableThinkingLevels: ThinkingLevel[];
}

export interface ExpectedSessionDefaultsDeps {
	globalSettingsManager: Pick<SettingsManager, "getGlobalSettings">;
	/** Optional project-scoped defaults from the SettingsManager used by runtime creation. */
	getDefaultSettings?: () => {
		defaultProvider?: string;
		defaultModel?: string;
		defaultThinkingLevel?: string;
	};
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
	/** 可用模型来源（builder 传 getAvailableModels(modelRegistry)）。 */
	getAvailableModels(): Array<{ provider: string; id: string }>;
}

const EMPTY_DEFAULTS: ExpectedSessionDefaults = {
	model: "",
	thinkingLevel: "off",
	modelSupportsThinking: false,
	availableThinkingLevels: ["off"],
};

/**
 * Keep the draft projection in lockstep with pi's findInitialModel fallback.
 * The SDK does not currently export this table from its package root, so this
 * small mirror is intentionally kept beside the projection and covered by a
 * regression test. Update it together with the pi SDK when provider defaults
 * change.
 */
const SDK_DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.5",
	radius: "auto",
	nvidia: "nvidia/nemotron-3-super-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.5",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.7",
	zai: "glm-5.1",
	"zai-coding-cn": "glm-5.1",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

/** Choose the same provider-default-first fallback that pi uses. */
export function selectSdkFallbackModel<T extends { provider: string; id: string }>(
	models: readonly T[],
): T | undefined {
	for (const [provider, id] of Object.entries(SDK_DEFAULT_MODEL_IDS)) {
		const match = models.find((model) => model.provider === provider && model.id === id);
		if (match) return match;
	}
	return models[0];
}

export function resolveExpectedSessionDefaults(deps: ExpectedSessionDefaultsDeps): ExpectedSessionDefaults {
	const sdk = (deps.getDefaultSettings?.() ?? deps.globalSettingsManager.getGlobalSettings()) as Record<
		string,
		unknown
	>;
	const saved =
		typeof sdk.defaultProvider === "string" && typeof sdk.defaultModel === "string"
			? deps.modelRegistry.find(sdk.defaultProvider, sdk.defaultModel)
			: undefined;
	// pi 步骤 3 的 auth 门：默认模型未配置凭据时跳过，落到步骤 4（provider 默认优先，
	// 无命中时取首个可用）。
	let resolved = saved && deps.modelRegistry.hasConfiguredAuth(saved) ? saved : undefined;
	if (!resolved) {
		const first = selectSdkFallbackModel(deps.getAvailableModels());
		resolved = first ? deps.modelRegistry.find(first.provider, first.id) : undefined;
	}
	if (!resolved) return EMPTY_DEFAULTS;

	const levels = getSupportedThinkingLevels(resolved) as ThinkingLevel[];
	const rawLevel =
		resolved === saved && typeof sdk.defaultThinkingLevel === "string"
			? (sdk.defaultThinkingLevel as ThinkingLevel)
			: "medium";
	return {
		model: `${resolved.provider}/${resolved.id}`,
		thinkingLevel: clampThinkingLevel(resolved, rawLevel) as ThinkingLevel,
		modelSupportsThinking: !!resolved.reasoning,
		availableThinkingLevels: levels,
	};
}
