// ============================================================
// Model List Extension — 为 Agent Session 提供已连接模型查询工具
//
// 注册 `look_list_models` 工具，供 Skill / LLM 获取当前已配置 API Key
// 的模型列表。只读、无副作用，与 permission / plan / subagent / mcp
// 扩展并列注入。
// ============================================================

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AvailableModel } from "@look/shared/types";
import { Type } from "typebox";

const ListModelsParams = Type.Object({});

export interface ListedModel {
	provider: string;
	id: string;
	name: string;
	key: string;
}

/**
 * 创建模型列表扩展工厂。
 *
 * @param getModels 返回当前已连接模型列表（排除 env-only / 未配置 auth）
 */
export function createModelListExtensionFactory(
	getModels: () => Promise<AvailableModel[]> | AvailableModel[],
): ExtensionFactory {
	return (api) => {
		api.registerTool<typeof ListModelsParams, { models: ListedModel[] }>({
			name: "look_list_models",
			label: "List connected models",
			description:
				"Return the list of currently connected models (providers with configured credentials). " +
				"Use this when the user needs to pick a model for a Look SubAgent or any task.",
			promptSnippet: "List available connected models",
			parameters: ListModelsParams,
			executionMode: "sequential",

			async execute() {
				try {
					const models = await getModels();
					const listed: ListedModel[] = models.map((model) => ({
						provider: model.provider,
						id: model.id,
						name: model.name,
						key: `${model.provider}/${model.id}`,
					}));
					return {
						content: [
							{
								type: "text",
								text:
									listed.length === 0
										? "No connected models found. Please configure API keys in settings first."
										: `Connected models:\n${listed
												.map((m, i) => `${i + 1}. ${m.name} (${m.key})`)
												.join("\n")}`,
							},
						],
						details: { models: listed },
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to list connected models: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { models: [] },
						isError: true,
					};
				}
			},
		});
	};
}
