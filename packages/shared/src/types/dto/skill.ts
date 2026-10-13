// 技能条目 DTO —— 镜像主进程 SkillManagementService.listForUI 的真实返回形状：
// - SDK 加载条目（pi `Skill`，provenance 在 sourceInfo，权威）
// - Look 本地扫描条目（discoverSkillsFromPaths，只有 legacy 自由格式 source）
// 两个分支的可选字段合并为一个结构，renderer 消费时按 sourceInfo?.source ?? source 读取。

import type { LookSourceInfo } from "./engine.js";

export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	/** pi SDK 的 per-skill provenance（SDK 加载的条目必有）。 */
	sourceInfo?: LookSourceInfo;
	/** legacy：Look 本地扫描（discoverSkillsFromPaths）的条目用自由格式 source。 */
	source?: string;
	disableModelInvocation?: boolean;
	category: "builtin" | "mine";
}

/** 镜像 pi SDK 的 ResourceDiagnostic（skills 加载诊断）。 */
export interface SkillDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
}
