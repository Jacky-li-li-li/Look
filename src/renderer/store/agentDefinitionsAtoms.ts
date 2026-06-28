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

// ---- Agent 广场 Tab 切换（Phase 1） ----

/** Agent 广场内的 Tab 状态：SubAgent / Agent Skills */
export const agentSquareTabAtom = atom<"subagent" | "skills">("subagent");

// ---- SubAgent 页面筛选 ----

/** SubAgent 页面的来源筛选：内置 / 我的 */
export const subagentSourceTabAtom = atom<"builtin" | "mine">("builtin");

// ---- Skill 页面 ----

/** 已加载的 Skill 列表（来自 listSkills IPC） */
export const agentSkillsAtom = atom<any[]>([]);

/** 是否正在加载 Skill 列表 */
export const agentSkillsLoadingAtom = atom(false);

/** Skill 页面的来源筛选：内置 / 我的 */
export const skillSourceTabAtom = atom<"builtin" | "mine">("builtin");
