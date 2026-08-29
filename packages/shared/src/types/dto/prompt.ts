// Prompt 变体相关 DTO —— LookAPI 与 InvokeResponseMap 共用。
// 主进程 PromptStore 的 PromptConfig/ProjectPromptData 与此结构一致，
// 路由器返回时经结构化类型对齐，无需显式转换。

/** 自定义 System Prompt 变体条目（全局与项目专属同形）。 */
export interface PromptEntry {
	id: string;
	name: string;
	content: string;
	isBuiltin: boolean;
	createdAt: number;
	updatedAt: number;
}

/** 项目级 prompt 覆盖数据（"跟随全局"由 activePromptId 哨兵值表达）。 */
export interface ProjectPromptDataDto {
	prompts: PromptEntry[];
	activePromptId: string;
}
