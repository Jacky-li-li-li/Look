// ============================================================
// PromptStore — 管理多个自定义 System Prompt 变体
//
// 数据存储于 ~/.look/prompts.json。
// 全局激活 prompt → ~/.look/SYSTEM.md（pi SDK discoverSystemPromptFile 自动发现）
// 项目激活 prompt → ~/.look/projects/<projectId>/SYSTEM.md（createRuntimeFactory 显式传入 systemPrompt）
// ============================================================

import fs from "fs";
import path from "path";
import { getProjectSystemPromptPath, getPromptsPath, getSystemPromptPath } from "../shared/look-storage.js";

/** 表示"跟随全局"的哨兵值 */
const FOLLOW_GLOBAL = "__follow_global__";

// ============================================================
// Types
// ============================================================

export interface PromptConfig {
	id: string;
	name: string;
	content: string;
	isBuiltin: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectPromptData {
	/** 项目专属 prompt 列表（空数组 = 完全跟随全局） */
	prompts: PromptConfig[];
	/** 激活的 prompt ID，"__follow_global__" 或 "" 表示跟随全局 */
	activePromptId: string;
}

interface PromptsFile {
	prompts: PromptConfig[];
	activePromptId: string;
	/** 项目级 prompt 配置：projectId → ProjectPromptData */
	projectOverrides: Record<string, ProjectPromptData>;
}

// ============================================================
// Built-in default prompt
// ============================================================

const BUILTIN_DEFAULT: PromptConfig = {
	id: "builtin-default",
	name: "Look 默认",
	isBuiltin: true,
	createdAt: 0,
	updatedAt: 0,
	content: [
		"Look — 看得见的 AI 伙伴",
		"",
		'你一定遇到过这样的情况：打开一个 AI 聊天窗口，对着一个孤零零的对话框说话，但你心里清楚——这只是一个对话，不是一个"帮手"。它不记得你的项目，不了解你的文件，每次都要从头解释。',
		"",
		"Look 就是为了解决这个问题而生的。",
		'它不是一个网页，不是一个命令行工具，而是一个真正跑在你电脑上的桌面应用。给 AI 一个项目上下文。你打开一个本地项目文件夹，选择一个 Agent，然后说"帮我把这个组件的 TypeScript 改成严格模式"——Agent 会先看你的代码、理解你的项目结构，再动手，最后把改了什么、为什么改，一五一十地告诉你！',
		"",
		"现在的状态",
		'Look 还在成长中。它有完整的构建管线，有国际化的中文、英文、日文界面，有市场化的 Agent 安装机制，甚至有一个 Agent 编辑器和技能商店的雏形。它还远没到"做完"的那一天——但这正是它有意思的地方：一个不断被它的创造者和使用者一起打磨的工具。',
	].join("\n"),
};

// ============================================================
// Helpers
// ============================================================

let uuidCounter = 0;
function newId(): string {
	uuidCounter++;
	return `prompt-${Date.now().toString(36)}-${uuidCounter.toString(36)}`;
}

// ============================================================
// PromptStore
// ============================================================

export class PromptStore {
	private data: PromptsFile;
	private readonly filePath: string;
	private readonly systemPromptPath: string;

	constructor() {
		this.filePath = getPromptsPath();
		this.systemPromptPath = getSystemPromptPath();
		this.data = this.load();
		this.migrateOldFormat();
		this.ensureBuiltin();
		this.syncSystemFile();
	}

	// ============================================================
	// Global prompt API
	// ============================================================

	list(): { prompts: PromptConfig[]; activePromptId: string; projectOverrides: Record<string, ProjectPromptData> } {
		return {
			prompts: [...this.data.prompts],
			activePromptId: this.data.activePromptId,
			projectOverrides: structuredClone(this.data.projectOverrides),
		};
	}

	create(name: string, content: string): PromptConfig {
		const now = Date.now();
		const prompt: PromptConfig = {
			id: newId(),
			name: name.trim(),
			content,
			isBuiltin: false,
			createdAt: now,
			updatedAt: now,
		};
		this.data.prompts.push(prompt);
		this.save();
		this.setActive(prompt.id);
		return { ...prompt };
	}

	update(id: string, patch: { name?: string; content?: string }): PromptConfig | null {
		const prompt = this.data.prompts.find((p) => p.id === id);
		if (!prompt || prompt.isBuiltin) return null;

		if (patch.name !== undefined) prompt.name = patch.name.trim();
		if (patch.content !== undefined) prompt.content = patch.content;
		prompt.updatedAt = Date.now();

		this.save();
		if (this.data.activePromptId === id) {
			this.syncSystemFile();
		}
		// 同步所有使用该 prompt 的项目级 SYSTEM.md
		this.syncProjectFilesForPrompt(id);
		return { ...prompt };
	}

	delete(id: string): boolean {
		const idx = this.data.prompts.findIndex((p) => p.id === id);
		if (idx === -1) return false;
		const prompt = this.data.prompts[idx];
		if (prompt.isBuiltin) return false;

		this.data.prompts.splice(idx, 1);

		// 清理项目级引用
		for (const projectId of Object.keys(this.data.projectOverrides)) {
			const proj = this.data.projectOverrides[projectId];
			const pidx = proj.prompts.findIndex((p) => p.id === id);
			if (pidx !== -1) {
				proj.prompts.splice(pidx, 1);
				if (proj.activePromptId === id) {
					proj.activePromptId = FOLLOW_GLOBAL;
				}
			}
		}

		if (this.data.activePromptId === id) {
			this.data.activePromptId = "builtin-default";
			this.syncSystemFile();
		}

		this.save();
		return true;
	}

	setActive(id: string): boolean {
		const prompt = this.data.prompts.find((p) => p.id === id);
		if (!prompt) return false;
		this.data.activePromptId = id;
		this.save();
		this.syncSystemFile();
		return true;
	}

	getActive(): PromptConfig | undefined {
		return this.data.prompts.find((p) => p.id === this.data.activePromptId);
	}

	// ============================================================
	// Project prompt API
	// ============================================================

	/** 获取项目的 prompt 配置（不存在则懒初始化） */
	private getOrCreateProjectData(projectId: string): ProjectPromptData {
		if (!this.data.projectOverrides[projectId]) {
			this.data.projectOverrides[projectId] = { prompts: [], activePromptId: FOLLOW_GLOBAL };
		}
		return this.data.projectOverrides[projectId];
	}

	/**
	 * 列出项目的 prompt 列表。
	 * 返回 prompts 和 activePromptId，以及一个 mergedList（全局 prompt + 项目专属 prompt 合并后的列表，
	 * 供 UI 下拉选择使用。每个项目专属 prompt 标记 isProjectLocal: true）。
	 */
	listProjectPrompts(projectId: string): {
		prompts: PromptConfig[];
		activePromptId: string;
		/** "跟随全局" 或全局 prompt ID 或项目专属 prompt ID */
	} {
		const proj = this.data.projectOverrides[projectId];
		if (!proj || proj.prompts.length === 0) {
			return { prompts: [], activePromptId: FOLLOW_GLOBAL };
		}
		return {
			prompts: [...proj.prompts],
			activePromptId: proj.activePromptId || FOLLOW_GLOBAL,
		};
	}

	createProjectPrompt(projectId: string, name: string, content: string): PromptConfig {
		const proj = this.getOrCreateProjectData(projectId);
		const now = Date.now();
		const prompt: PromptConfig = {
			id: newId(),
			name: name.trim(),
			content,
			isBuiltin: false,
			createdAt: now,
			updatedAt: now,
		};
		proj.prompts.push(prompt);
		this.save();
		// 新创建自动激活
		this.setProjectActive(projectId, prompt.id);
		return { ...prompt };
	}

	updateProjectPrompt(
		projectId: string,
		promptId: string,
		patch: { name?: string; content?: string },
	): PromptConfig | null {
		const proj = this.data.projectOverrides[projectId];
		if (!proj) return null;
		const prompt = proj.prompts.find((p) => p.id === promptId);
		if (!prompt) return null;

		if (patch.name !== undefined) prompt.name = patch.name.trim();
		if (patch.content !== undefined) prompt.content = patch.content;
		prompt.updatedAt = Date.now();

		this.save();
		if (proj.activePromptId === promptId) {
			// 重新写项目 SYSTEM.md
			this.writeProjectSystemFileForProject(projectId);
		}
		return { ...prompt };
	}

	deleteProjectPrompt(projectId: string, promptId: string): boolean {
		const proj = this.data.projectOverrides[projectId];
		if (!proj) return false;
		const idx = proj.prompts.findIndex((p) => p.id === promptId);
		if (idx === -1) return false;

		proj.prompts.splice(idx, 1);
		if (proj.activePromptId === promptId) {
			proj.activePromptId = FOLLOW_GLOBAL;
			this.deleteProjectSystemFileForProject(projectId);
		}
		this.save();
		return true;
	}

	setProjectActive(projectId: string, promptId: string): boolean {
		const proj = this.getOrCreateProjectData(projectId);
		const prompt = proj.prompts.find((p) => p.id === promptId);
		if (!prompt && promptId !== FOLLOW_GLOBAL) return false;

		proj.activePromptId = promptId;
		this.save();
		this.writeProjectSystemFileForProject(projectId);
		return true;
	}

	/** 获取指定项目最终使用的 prompt 内容（项目级优先，回退全局） */
	getEffectivePromptContent(projectId: string, projectCwd?: string): string {
		const proj = this.data.projectOverrides[projectId];
		if (proj?.activePromptId && proj.activePromptId !== FOLLOW_GLOBAL) {
			const p = proj.prompts.find((pp) => pp.id === proj.activePromptId);
			if (p) return p.content;
		}
		const active = this.getActive();
		return active?.content ?? BUILTIN_DEFAULT.content;
	}

	// ============================================================
	// 向后兼容的旧 API（供可能的旧代码调用）
	// ============================================================

	/** @deprecated 新代码应使用项目专属 prompt */
	setProjectPrompt(projectId: string, promptId: string | null, _projectCwd?: string): void {
		if (promptId) {
			const proj = this.getOrCreateProjectData(projectId);
			const prompt = this.data.prompts.find((p) => p.id === promptId);
			if (prompt) {
				const exists = proj.prompts.find((p) => p.id === promptId);
				if (!exists) {
					proj.prompts.push({ ...prompt, isBuiltin: false });
				}
				proj.activePromptId = promptId;
				this.save();
				this.writeProjectSystemFileForProject(projectId);
			}
		} else {
			const proj = this.data.projectOverrides[projectId];
			if (proj) {
				proj.activePromptId = FOLLOW_GLOBAL;
				this.save();
				this.deleteProjectSystemFileForProject(projectId);
			}
		}
	}

	/** @deprecated */
	getProjectPrompt(projectId: string): string | null {
		const proj = this.data.projectOverrides[projectId];
		if (proj?.activePromptId && proj.activePromptId !== FOLLOW_GLOBAL) {
			return proj.activePromptId;
		}
		return null;
	}

	// ============================================================
	// File sync
	// ============================================================

	/**
	 * 写入项目 SYSTEM.md（~/.look/projects/<projectId>/SYSTEM.md）。
	 * 如果项目激活的是 FOLLOW_GLOBAL，则删除项目 SYSTEM.md。
	 */
	private writeProjectSystemFileForProject(projectId: string): void {
		const proj = this.data.projectOverrides[projectId];
		if (!proj) return;
		const filePath = getProjectSystemPromptPath(projectId);
		if (proj.activePromptId === FOLLOW_GLOBAL) {
			this.deleteProjectSystemFileForProject(projectId);
			return;
		}
		const prompt = proj.prompts.find((p) => p.id === proj.activePromptId);
		if (!prompt) return;
		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, prompt.content, "utf-8");
		} catch (err) {
			console.error(`[Look] Failed to write project SYSTEM.md for ${projectId}:`, err);
		}
	}

	private deleteProjectSystemFileForProject(projectId: string): void {
		try {
			const filePath = getProjectSystemPromptPath(projectId);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		} catch (err) {
			console.error(`[Look] Failed to delete project SYSTEM.md for ${projectId}:`, err);
		}
	}

	/**
	 * 当全局 prompt 内容更新时，同步所有使用该 prompt 的项目级 SYSTEM.md。
	 */
	private syncProjectFilesForPrompt(promptId: string): void {
		const prompt = this.data.prompts.find((p) => p.id === promptId);
		if (!prompt) return;
		for (const [projectId, proj] of Object.entries(this.data.projectOverrides)) {
			if (proj.activePromptId === promptId) {
				const pp = proj.prompts.find((p) => p.id === promptId);
				if (pp) {
					pp.content = prompt.content;
				}
				this.writeProjectSystemFileForProject(projectId);
			}
		}
		this.save();
	}

	/**
	 * 同步指定项目的 SYSTEM.md —— 由 IPC handler 调用（不再需要 cwd）。
	 */
	syncProjectSystemFile(projectId: string, _projectCwd?: string): void {
		const proj = this.data.projectOverrides[projectId];
		if (!proj || proj.activePromptId === FOLLOW_GLOBAL) {
			this.deleteProjectSystemFileForProject(projectId);
			return;
		}
		const prompt = proj.prompts.find((p) => p.id === proj.activePromptId);
		if (prompt) {
			this.writeProjectSystemFileForProject(projectId);
		}
	}

	/** @deprecated — 兼容旧调用签名 */
	syncProjectOverridesForPrompt(promptId: string, _projectCwds?: Record<string, string>): void {
		const prompt = this.data.prompts.find((p) => p.id === promptId);
		if (!prompt) return;
		for (const projectId of Object.keys(this.data.projectOverrides)) {
			const proj = this.data.projectOverrides[projectId];
			if (proj.activePromptId === promptId) {
				this.writeProjectSystemFileForProject(projectId);
			}
		}
	}

	// ============================================================
	// Internal
	// ============================================================

	private load(): PromptsFile {
		try {
			if (fs.existsSync(this.filePath)) {
				const raw = fs.readFileSync(this.filePath, "utf-8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed.prompts) && typeof parsed.activePromptId === "string") {
					if (!parsed.projectOverrides || typeof parsed.projectOverrides !== "object") {
						parsed.projectOverrides = {};
					}
					return parsed as PromptsFile;
				}
			}
		} catch (err) {
			console.warn("[Look] Failed to load prompts.json, using defaults:", err);
		}
		return { prompts: [], activePromptId: "builtin-default", projectOverrides: {} };
	}

	/**
	 * 从旧格式迁移：旧 projectOverrides 是 Record<string, string> (projectId → promptId)
	 * 新格式是 Record<string, ProjectPromptData>
	 */
	private migrateOldFormat(): void {
		let migrated = false;
		for (const [projectId, value] of Object.entries(this.data.projectOverrides)) {
			// 旧格式：value 是字符串（promptId）
			if (typeof value === "string") {
				const promptId = value;
				const prompt = this.data.prompts.find((p) => p.id === promptId);
				this.data.projectOverrides[projectId] = {
					prompts: prompt ? [{ ...prompt, isBuiltin: false }] : [],
					activePromptId: promptId,
				};
				migrated = true;
			}
			// 已经是新格式，确保 activePromptId 有效
			if (typeof value === "object" && value !== null) {
				const ppd = value as ProjectPromptData;
				if (typeof ppd.activePromptId !== "string") {
					ppd.activePromptId = FOLLOW_GLOBAL;
				}
				if (!Array.isArray(ppd.prompts)) {
					ppd.prompts = [];
				}
			}
		}
		if (migrated) {
			this.save();
			console.log("[Look] Migrated old-format projectOverrides to new format");
		}
	}

	private ensureBuiltin(): void {
		const existing = this.data.prompts.find((p) => p.id === "builtin-default");
		const now = Date.now();
		if (existing) {
			existing.content = BUILTIN_DEFAULT.content;
			existing.name = BUILTIN_DEFAULT.name;
			existing.updatedAt = now;
		} else {
			this.data.prompts.unshift({
				...BUILTIN_DEFAULT,
				createdAt: now,
				updatedAt: now,
			});
		}
		this.save();
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
		} catch (err) {
			console.error("[Look] Failed to write prompts.json:", err);
		}
	}

	private syncSystemFile(): void {
		try {
			const active = this.getActive();
			if (active) {
				fs.mkdirSync(path.dirname(this.systemPromptPath), { recursive: true });
				fs.writeFileSync(this.systemPromptPath, active.content);
			}
		} catch (err) {
			console.error("[Look] Failed to write SYSTEM.md:", err);
		}
	}
}
