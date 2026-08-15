// ============================================================
// resolveExpectedSessionDefaults — 草稿行预期默认值回归测试
//
// 草稿值必须与 runtime 绑定后 pi findInitialModel 的真实值一致，
// 否则初始化完成时模型/思考选择器整行跳变。
// ============================================================

import { describe, expect, it } from "vitest";
import {
	type ExpectedSessionDefaultsDeps,
	resolveExpectedSessionDefaults,
} from "../src/main/session/services/expected-session-defaults.js";

/** pi Model 的最小形状（getSupportedThinkingLevels/clampThinkingLevel 只读这些字段）。 */
function model(overrides: {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, number | null>;
}) {
	return {
		provider: overrides.provider,
		id: overrides.id,
		reasoning: overrides.reasoning ?? false,
		thinkingLevelMap: overrides.thinkingLevelMap,
	};
}

function makeDeps(args: {
	sdkSettings?: Record<string, unknown>;
	models?: Array<ReturnType<typeof model>>;
	authProviders?: string[];
	defaultSettings?: {
		defaultProvider?: string;
		defaultModel?: string;
		defaultThinkingLevel?: string;
	};
	available?: Array<{ provider: string; id: string }>;
}): ExpectedSessionDefaultsDeps {
	const models = args.models ?? [];
	const authProviders = new Set(args.authProviders ?? models.map((m) => m.provider));
	return {
		globalSettingsManager: {
			getGlobalSettings: () => args.sdkSettings ?? {},
		},
		getDefaultSettings: args.defaultSettings ? () => args.defaultSettings! : undefined,
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: (m: { provider: string }) => authProviders.has(m.provider),
		},
		getAvailableModels: () => args.available ?? models.map((m) => ({ provider: m.provider, id: m.id })),
	};
}

describe("resolveExpectedSessionDefaults", () => {
	it("settings 默认模型（凭据就绪）胜出，defaultThinkingLevel 生效", () => {
		const deps = makeDeps({
			sdkSettings: {
				defaultProvider: "anthropic",
				defaultModel: "claude-opus-4-8",
				defaultThinkingLevel: "high",
			},
			models: [model({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true })],
		});
		expect(resolveExpectedSessionDefaults(deps)).toEqual({
			model: "anthropic/claude-opus-4-8",
			thinkingLevel: "high",
			modelSupportsThinking: true,
			availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
		});
	});

	it("项目级默认模型覆盖全局设置，草稿使用 runtime 同一份合并结果", () => {
		const deps = makeDeps({
			sdkSettings: { defaultProvider: "openai", defaultModel: "gpt-5.5" },
			defaultSettings: {
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-pro",
				defaultThinkingLevel: "high",
			},
			models: [
				model({ provider: "openai", id: "gpt-5.5" }),
				model({ provider: "deepseek", id: "deepseek-v4-pro", reasoning: true }),
			],
		});
		expect(resolveExpectedSessionDefaults(deps)).toMatchObject({
			model: "deepseek/deepseek-v4-pro",
			thinkingLevel: "high",
		});
	});

	it("默认模型凭据缺失时 pi 会跳过——草稿同样落到 provider 默认优先的可用模型", () => {
		const deps = makeDeps({
			sdkSettings: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" },
			models: [
				model({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true }),
				model({ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true }),
			],
			authProviders: ["deepseek"],
			// getAvailableModels 的真实语义已按凭据过滤——未授权模型不在列。
			available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
		});
		const result = resolveExpectedSessionDefaults(deps);
		expect(result.model).toBe("deepseek/deepseek-v4-flash");
		// 兜底路径：pi 用 DEFAULT_THINKING_LEVEL（"medium"），不用 settings 存量
		expect(result.thinkingLevel).toBe("medium");
	});

	it("provider 有多个可用模型时遵循 pi 的默认模型表，而不是列表第一项", () => {
		const deps = makeDeps({
			models: [
				model({ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true }),
				model({ provider: "deepseek", id: "deepseek-v4-pro", reasoning: true }),
			],
			// 运行时的可用列表当前按 flash 在前返回，但 pi 默认是 pro。
			available: [
				{ provider: "deepseek", id: "deepseek-v4-flash" },
				{ provider: "deepseek", id: "deepseek-v4-pro" },
			],
		});
		expect(resolveExpectedSessionDefaults(deps).model).toBe("deepseek/deepseek-v4-pro");
	});

	it("非推理模型：级别只有 off，思考级别收敛为 off", () => {
		const deps = makeDeps({
			sdkSettings: { defaultProvider: "x", defaultModel: "m1", defaultThinkingLevel: "high" },
			models: [model({ provider: "x", id: "m1" })],
		});
		const result = resolveExpectedSessionDefaults(deps);
		expect(result.modelSupportsThinking).toBe(false);
		expect(result.availableThinkingLevels).toEqual(["off"]);
		expect(result.thinkingLevel).toBe("off");
	});

	it("级别表按模型裁剪：xhigh/max 仅显式映射的模型才有；存量越级值就近收敛", () => {
		const deps = makeDeps({
			sdkSettings: {
				defaultProvider: "x",
				defaultModel: "m1",
				defaultThinkingLevel: "xhigh",
			},
			models: [
				// xhigh/max 未映射 → 不在可用级别里；保存的 "xhigh" 应收敛到 "high"
				model({ provider: "x", id: "m1", reasoning: true, thinkingLevelMap: { high: 80 } }),
			],
		});
		const result = resolveExpectedSessionDefaults(deps);
		expect(result.availableThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(result.thinkingLevel).toBe("high");
	});

	it("无任何可用模型时退回空占位（草稿仍可显示，模型留空）", () => {
		const deps = makeDeps({ models: [] });
		expect(resolveExpectedSessionDefaults(deps)).toEqual({
			model: "",
			thinkingLevel: "off",
			modelSupportsThinking: false,
			availableThinkingLevels: ["off"],
		});
	});
});
