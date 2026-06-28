// ============================================================
// Agent Definitions — Agent 广场状态（Stage 3）
// ============================================================

import type { AgentDefinitionInfo } from "@shared/types";
import { atom } from "jotai";

/** 已加载的 Agent 定义列表（来自 listAgentDefinitions IPC） */
export const agentDefinitionsAtom = atom<AgentDefinitionInfo[]>([]);

/** 当前选中的 Agent（卡片点击选中，在详情/编辑面板中展示） */
export const selectedAgentDefinitionAtom = atom<AgentDefinitionInfo | null>(null);

/** Agent 编辑器是否打开（null = 关闭，create = 新建，"name" = 编辑该 Agent） */
export const agentEditorTargetAtom = atom<"create" | string | null>(null);

/** Agent 广场分类筛选（null = 全部） */
export const agentFilterTagAtom = atom<string | null>(null);

/** Agent 搜索文本 */
export const agentSearchTextAtom = atom("");

/** 是否正在加载 Agent 列表 */
export const agentDefinitionsLoadingAtom = atom(false);
