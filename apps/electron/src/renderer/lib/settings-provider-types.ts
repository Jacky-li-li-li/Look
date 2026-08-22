// ============================================================
// settings-provider-types — provider 设置 DTO（store 与组件共用的规范位置）
//
// 此前定义在 components/settings/types.ts，导致 store 层反向依赖
// 组件层；下沉到 lib 后 components/settings/types.ts 仅做再导出。
// ============================================================

export type { CustomProviderInput, CustomProviderModelInput } from "@look/shared";

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
