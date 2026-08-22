// ============================================================
// settings/types.ts — Shared types for settings tabs
//
// provider DTO 的规范定义在 lib/settings-provider-types.ts，此处再导出
// 保持组件内 "./types" 导入不变。
// ============================================================

export type {
	CustomProviderInput,
	CustomProviderModelInput,
	ProviderInfo,
	ProviderModelInfo,
} from "../../lib/settings-provider-types.js";
export type { ImChannelInfo } from "../../store/imAtoms.js";

export type TestVerdict = { verdict: "ok" | "error" | "skipped"; reason?: string } | null;

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

export interface FeishuConnectOptions {
	appName?: string;
	description?: string;
}
