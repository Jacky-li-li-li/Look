// ============================================================
// SubAgent Extension — Agent 发现
//
// 扫描 Agent 定义文件（YAML frontmatter + Markdown body），
// 与 pi SDK 示例的 discoverAgents 逻辑对齐，但发现路径改为
// Look 的 ~/.look/agents（用户级）和 .pi/agents（项目级）。
// 复用 SDK 的 parseFrontmatter 工具保证 frontmatter 解析一致。
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getLookDir } from "../../shared/look-storage.js";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentSource } from "./types.js";

/** 用户级 Agent 目录：~/.look/agents */
export function getUserAgentsDir(): string {
	return path.join(getLookDir(), "agents");
}

/** 广场安装的 Agent 目录：~/.look/agents/marketplace */
export function getMarketplaceAgentsDir(): string {
	return path.join(getUserAgentsDir(), "marketplace");
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** 从 cwd 向上遍历，找到最近的 .pi/agents 目录 */
export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** 解析单个 Agent 定义文件 */
export function parseAgentFile(filePath: string, source: AgentSource): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	const toolsRaw = typeof frontmatter.tools === "string" ? frontmatter.tools : "";
	const tools = toolsRaw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined;
	const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() || undefined : undefined;
	const icon = typeof frontmatter.icon === "string" ? frontmatter.icon.trim() || undefined : undefined;
	const version = typeof frontmatter.version === "string" ? frontmatter.version.trim() || undefined : undefined;
	const author = typeof frontmatter.author === "string" ? frontmatter.author.trim() || undefined : undefined;
	const tagsRaw = typeof frontmatter.tags === "string" ? frontmatter.tags : "";
	const tags = tagsRaw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

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
	};
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!isDirectory(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		// marketplace 子目录单独处理，不在此处重复扫描
		if (entry.isDirectory()) continue;
		const filePath = path.join(dir, entry.name);
		const agent = parseAgentFile(filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

/** 加载广场安装的 Agent（~/.look/agents/marketplace/*.md） */
export function listInstalledMarketplaceAgents(): AgentConfig[] {
	return loadAgentsFromDir(getMarketplaceAgentsDir(), "marketplace");
}

/**
 * 发现可用 Agent。
 *
 * scope:
 *   - "user"     → 仅 ~/.look/agents（顶层，不含 marketplace 子目录）
 *   - "project"  → 仅 .pi/agents
 *   - "both"     → user + project（项目级覆盖同名用户级）
 *
 * marketplace Agent 始终并入用户级结果（作为 user 来源的补充）。
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = getUserAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const marketplaceAgents = scope === "project" ? [] : listInstalledMarketplaceAgents();
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// 同名优先级：project > user > marketplace
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of marketplaceAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** 格式化 Agent 列表为紧凑字符串（供工具描述 / 错误提示） */
export function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "(none)";
	return agents.map((a) => `${a.name} [${a.source}]: ${a.description}`).join("; ");
}
