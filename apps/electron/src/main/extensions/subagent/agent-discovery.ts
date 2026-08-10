// ============================================================
// SubAgent Extension — Agent 发现
//
// 扫描 Agent 定义文件（YAML frontmatter + Markdown body）。
// 发现路径：
//   - 用户级：~/.look/agents/
//   - 内置：  ~/.look/agents/marketplace/
//   - 项目级：~/.look/projects/<projectId>/agents/
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getLookDir, getProjectAgentsDir } from "@look/shared/look-storage";
import type { AgentConfig, AgentCreationMethod, AgentDiscoveryResult, AgentScope, AgentSource } from "./types.js";

/** 用户级 Agent 目录：~/.look/agents */
export function getUserAgentsDir(): string {
	return path.join(getLookDir(), "agents");
}

/** 内置 Agent 目录：~/.look/agents/marketplace（物理目录名保留兼容） */
export function getBuiltinAgentsDir(): string {
	return path.join(getUserAgentsDir(), "marketplace");
}

async function isDirectory(p: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

/** 获取项目级 Agent 目录（~/.look/projects/<projectId>/agents） */
export function findProjectAgentsDir(projectId: string): string {
	return getProjectAgentsDir(projectId);
}

/** 解析单个 Agent 定义文件 */
export async function parseAgentFile(filePath: string, source: AgentSource): Promise<AgentConfig | null> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	const toolsRaw = typeof frontmatter.tools === "string" ? frontmatter.tools : "";
	const tools = toolsRaw.split(",").flatMap((t) => t.trim() || []);
	const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined;
	const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() || undefined : undefined;
	const icon = typeof frontmatter.icon === "string" ? frontmatter.icon.trim() || undefined : undefined;
	const version = typeof frontmatter.version === "string" ? frontmatter.version.trim() || undefined : undefined;
	const author = typeof frontmatter.author === "string" ? frontmatter.author.trim() || undefined : undefined;
	const tagsRaw = typeof frontmatter.tags === "string" ? frontmatter.tags : "";
	const tags = tagsRaw.split(",").flatMap((t) => t.trim() || []);
	const createdByRaw = typeof frontmatter.createdBy === "string" ? frontmatter.createdBy.trim() : "";
	const createdBy: AgentCreationMethod | undefined =
		createdByRaw === "editor" ||
		createdByRaw === "skill" ||
		createdByRaw === "install" ||
		createdByRaw === "drag" ||
		createdByRaw === "seed" ||
		createdByRaw === "unknown"
			? createdByRaw
			: createdByRaw
				? "unknown"
				: undefined;
	const createdAt = typeof frontmatter.createdAt === "number" ? frontmatter.createdAt : undefined;
	const installedAt = typeof frontmatter.installedAt === "number" ? frontmatter.installedAt : undefined;

	return {
		name,
		title,
		description,
		tools: tools.length > 0 ? tools : undefined,
		model,
		systemPrompt: body,
		source,
		filePath,
		icon,
		tags: tags.length > 0 ? tags : undefined,
		version,
		author,
		createdBy,
		createdAt,
		installedAt,
	};
}

async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentConfig[]> {
	const agents: AgentConfig[] = [];
	if (!(await isDirectory(dir))) return agents;

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		// marketplace 子目录单独处理，不在此处重复扫描（由 listBuiltinAgents 处理）
		if (entry.isDirectory()) continue;
		const filePath = path.join(dir, entry.name);
		const agent = await parseAgentFile(filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

/** 加载内置 Agent（~/.look/agents/marketplace/*.md，source="builtin"） */
export async function listBuiltinAgents(): Promise<AgentConfig[]> {
	return loadAgentsFromDir(getBuiltinAgentsDir(), "builtin");
}

/**
 * 发现可用 Agent。
 *
 * scope:
 *   - "user"     → 仅 ~/.look/agents（顶层，不含 marketplace 子目录）
 *   - "project"  → 仅 ~/.look/projects/<projectId>/agents
 *   - "both"     → user + project（项目级覆盖同名用户级）
 *
 * builtin Agent 始终并入用户级结果（作为最底层的 fallback）。
 */
export async function discoverAgents(projectId: string, scope: AgentScope): Promise<AgentDiscoveryResult> {
	const userDir = getUserAgentsDir();
	// 空 projectId 表示“无项目上下文”（用户级查询），不解析项目级目录，
	// 避免 getProjectAgentsDir 对空 ID 触发 assertSafeProjectId。
	const projectAgentsDir = projectId.length > 0 ? getProjectAgentsDir(projectId) : null;

	const userAgents = scope === "project" ? [] : await loadAgentsFromDir(userDir, "user");
	const builtinAgents = scope === "project" ? [] : await listBuiltinAgents();
	const projectAgents =
		scope === "user" || !projectAgentsDir || !(await isDirectory(projectAgentsDir))
			? []
			: await loadAgentsFromDir(projectAgentsDir, "project");

	// 同名优先级：project > user > builtin
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** 格式化 Agent 列表为紧凑字符串（供工具描述 / 错误提示） */
export function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "(none)";
	return agents.map((a) => `${a.name} [${a.source}]: ${a.description}`).join("; ");
}
