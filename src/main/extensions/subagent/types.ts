// ============================================================
// SubAgent Extension — 类型定义
//
// 与 pi SDK 的 subagent 示例（examples/extensions/subagent/agents.ts）
// 的 AgentConfig frontmatter 格式保持兼容，并扩展 Look 所需字段。
//
// 与 Proma/Claude Agent SDK 的 SubAgent 系统完全不同：本扩展基于
// pi SDK 的 Extension 模式实现，子会话走完整的 Look
// SessionRuntimeManager 生命周期。
// ============================================================

/** Agent 定义来源 */
export type AgentSource = "user" | "project" | "builtin";

/** Agent 发现范围（与 SDK 示例兼容） */
export type AgentScope = "user" | "project" | "both";

/** Agent 创建方式（追踪 Agent 是如何产生的） */
export type AgentCreationMethod =
	| "editor" // AgentEditor UI 手动创建
	| "skill" // look-agent-builder Skill 创建
	| "install" // 从内置目录安装（marketplace → user dir）
	| "drag" // 文件拖放/手动放入 agents 目录
	| "seed" // 由 syncLookDefaultAgents 种子写入
	| "unknown"; // 无法判断的遗留文件

/**
 * Agent 定义（与 SDK frontmatter 兼容 + Look 扩展字段）。
 *
 * frontmatter 字段：name / description / tools / model
 * body：systemPrompt（Markdown）
 * Look 扩展：title / icon / tags / version / author / source / filePath
 */
export interface AgentConfig {
	/** 唯一标识（frontmatter name） */
	name: string;
	/** 显示名称（可选，缺省回退到 name） */
	title?: string;
	/** 一句话描述（frontmatter description） */
	description: string;
	/** 工具白名单（frontmatter tools，逗号分割）。undefined 表示继承全部工具 */
	tools?: string[];
	/** 模型 "provider/model-id"（frontmatter model） */
	model?: string;
	/** 系统提示（frontmatter 之后的 Markdown body） */
	systemPrompt: string;
	/** 来源：用户级 / 项目级 / 广场安装 */
	source: AgentSource;
	/** 定义文件绝对路径 */
	filePath: string;
	/** 可选图标（emoji） */
	icon?: string;
	/** 分类标签 */
	tags?: string[];
	/** 版本号 */
	version?: string;
	/** 作者 */
	author?: string;
	/** 创建方式（追踪 Agent 是如何产生的） */
	createdBy?: AgentCreationMethod;
	/** 创建时间戳（ms） */
	createdAt?: number;
	/** 安装时间戳（从 builtin 目录安装时记录） */
	installedAt?: number;
}

/** Agent 发现结果 */
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	/** 项目级 Agent 目录路径（~/.look/projects/<projectId>/agents） */
	projectAgentsDir: string | null;
}

/** 子会话用量统计（与 SDK 示例的 UsageStats 对齐） */
export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** 子会话执行状态 */
export type SubagentStatus = "running" | "completed" | "failed" | "aborted";

/** 单个子会话执行结果 */
export interface SubagentResult {
	/** 子会话 pi session ID */
	sessionId: string;
	agentName: string;
	agentSource: AgentSource;
	task: string;
	status: SubagentStatus;
	/** 子会话显示标题（来自 taskItem.title 或自动拼接） */
	title?: string;
	/** 子会话最后一条 assistant 文本输出 */
	finalOutput: string;
	usage: SubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** chain 模式下的步骤序号（从 1 开始） */
	step?: number;
}

/** 流式进度回调载荷 */
export interface SubagentProgress {
	childSessionId: string;
	parentSessionId: string;
	agentName: string;
	task: string;
	status: SubagentStatus;
	/** 当前累积的输出（可能不完整） */
	partialOutput: string;
	usage: SubagentUsage;
	model?: string;
}

/** 工具返回给 LLM 的 details（供渲染层 Stage 5 进度卡片消费） */
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	results: SubagentResult[];
}

/** parallel 模式的任务项 */
export interface SubagentTaskItem {
	agent: string;
	task: string;
	/** 可选：子会话显示标题（不填则自动拼接 agentName + task 摘要） */
	title?: string;
}

/** chain 模式的步骤项（task 可含 {previous} 占位符） */
export interface SubagentChainItem {
	agent: string;
	task: string;
	title?: string;
}

/**
 * SubAgent 扩展宿主接口——由 SessionRuntimeManager 实现。
 * 扩展通过此接口与主进程解耦，模仿 PlanExtensionHost 的模式。
 */
export interface SubagentHost {
	/** 发现可用 Agent */
	discoverAgents(projectId: string, scope: AgentScope): Promise<AgentDiscoveryResult>;
	/**
	 * 创建并运行一个子会话，返回其最终结果。
	 * 子会话作为完整 Look 会话注册到 SessionRuntimeManager，
	 * 出现在侧边栏（Stage 4 嵌套），可持久化、可交互。
	 */
	runSubSession(
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate?: (progress: SubagentProgress) => void,
		title?: string,
	): Promise<SubagentResult>;
	/** Agent 开关状态（Stage 2 持久化；Stage 1 恒为 true） */
	isSubagentEnabled(sessionId: string): boolean;
}

/** 零用量初值 */
export function zeroUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** 格式化用量为紧凑字符串（供结果摘要） */
export function formatUsage(usage: SubagentUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
