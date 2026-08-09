// ============================================================
// Subagent router — sub-session queries, agent definitions, skill toggles
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceSubsessionsDir } from "@look/shared/look-storage";
import { guardAgentDefinitionInput, guardAgentId, guardBoolean, guardEnum, guardString } from "../guards.js";
import type { InvokeContext, IpcRouter } from "../invoke-context.js";

/**
 * agent-definitions:install 的合法安装来源（与 renderer-to-main 契约同步）。
 * 目前仅支持内置来源；扩展其他来源时在此追加枚举即可。
 */
const INSTALL_SOURCES = ["builtin"] as const;

/** 审核子会话命名（渲染端 delegation 匹配依赖此前缀，改动需同步）。 */
const REVIEW_TITLE = "审核本轮变更";
/** 子会话 delegation 记录类型（main 侧 session-catalog 常量）。 */
const DELEGATION_ENTRY_TYPE = "look.delegation.v1";

/**
 * 审核查询结果的内存缓存（TTL 10s）：避免重复点击审核时反复全量扫描
 * 子会话目录（每次都要逐行解析所有子会话 JSONL，子会话多时成本明显）。
 * key = `${parentSessionId}:${turnKey}`，轮次变化天然不命中。
 */
const reviewLookupCache = new Map<string, { childSessionId: string | null; at: number }>();
const REVIEW_LOOKUP_TTL_MS = 10_000;

/**
 * 查找父会话已绑定的审核子会话（防重复创建）。
 * 按 delegation 记录匹配（parentSessionId + `Agent：<title>`），取最近创建的一个。
 * 子会话由主 Agent 通过 subagent 工具创建后，delegation 记录写在其 JSONL 中；
 * 磁盘扫描保证重启后依然命中。注意：轮次隔离依赖渲染端把 turnKey 编入 title
 * （如「审核本轮变更 (entry-xxx)」）——同名 title 会命中最近一次同名审核会话。
 */
async function findExistingReviewSession(
	ctx: InvokeContext,
	parentSessionId: string,
	turnKey: string,
	agentName: string,
): Promise<string | null> {
	const cacheKey = `${parentSessionId}:${turnKey}`;
	const cached = reviewLookupCache.get(cacheKey);
	if (cached && Date.now() - cached.at < REVIEW_LOOKUP_TTL_MS) return cached.childSessionId;

	const stored = ctx.session.info.getStoredSession(parentSessionId);
	if (!stored) {
		reviewLookupCache.set(cacheKey, { childSessionId: null, at: Date.now() });
		return null;
	}
	const subsessionsDir = getWorkspaceSubsessionsDir(stored.projectId);
	let files: string[] = [];
	try {
		files = (await fs.promises.readdir(subsessionsDir)).filter((file) => file.endsWith(".jsonl"));
	} catch {
		reviewLookupCache.set(cacheKey, { childSessionId: null, at: Date.now() });
		return null;
	}

	let fallback: { childSessionId: string; createdAt: string } | null = null;
	for (const file of files) {
		const filePath = path.join(subsessionsDir, file);
		// 匹配 delegation 记录（agentName + parentSessionId + createdAt）
		const delegation = await readReviewDelegation(filePath, parentSessionId, agentName);
		if (delegation && (!fallback || delegation.createdAt > fallback.createdAt)) {
			fallback = delegation;
		}
	}
	const result = fallback?.childSessionId ?? null;
	reviewLookupCache.set(cacheKey, { childSessionId: result, at: Date.now() });
	return result;
}

/** 从子会话 JSONL 读取匹配 (parentSessionId, agentName) 的最新 delegation 记录。 */
async function readReviewDelegation(
	filePath: string,
	parentSessionId: string,
	agentName: string,
): Promise<{ childSessionId: string; createdAt: string } | null> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
	let latest: { childSessionId: string; createdAt: string } | null = null;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; customType?: string; data?: Record<string, unknown> };
		try {
			entry = JSON.parse(line) as { type?: string; customType?: string; data?: Record<string, unknown> };
		} catch {
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== DELEGATION_ENTRY_TYPE) continue;
		const data = entry.data;
		if (
			typeof data?.parentSessionId === "string" &&
			data.parentSessionId === parentSessionId &&
			typeof data.agentName === "string" &&
			data.agentName === agentName &&
			typeof data.childSessionId === "string" &&
			typeof data.createdAt === "string"
		) {
			if (!latest || data.createdAt > latest.createdAt) {
				latest = { childSessionId: data.childSessionId, createdAt: data.createdAt };
			}
		}
	}
	return latest;
}

export const subagentRouter: IpcRouter = (ctx, register) => {
	register("agent:list-subagents", async (data) => {
		const parentId = guardAgentId(data.parentSessionId, "parentSessionId");
		return { success: true, childSessionIds: ctx.agent.subAgentRegistry.listChildren(parentId) };
	});

	register("agent:get-parent-session", async (data) => {
		const childId = guardAgentId(data.childSessionId, "childSessionId");
		return { success: true, parentSessionId: ctx.agent.subAgentRegistry.getParent(childId) };
	});

	register("agent:set-subagent-enabled", async (data) => {
		guardBoolean(data.enabled, "enabled");
		await ctx.agent.subagentService.setEnabledGlobal(data.enabled);
		return { success: true, enabled: data.enabled };
	});

	register("agent:review-changes", async (data) => {
		const parentSessionId = guardAgentId(data.parentSessionId, "parentSessionId");
		const title = guardString(data.title, "title").trim() || REVIEW_TITLE;
		const turnKey = guardString(data.turnKey, "turnKey").trim();

		// 审核会话由主 Agent 通过 subagent 工具创建（消息流可见 subagent 工具卡）。
		// 本路由只负责「查找已有审核子会话」（防重复）：命中返回 childSessionId，
		// 未命中返回 null，由渲染端注入 /subagent:reviewer 委派指令。
		const existing = await findExistingReviewSession(ctx, parentSessionId, turnKey, `Agent：${title}`);
		return { success: true, childSessionId: existing ?? null, title };
	});

	register("agent-definitions:list", async () => {
		return { success: true, agents: await ctx.agent.definitions.listDefinitions() };
	});

	register("agent-definitions:create", async (data) => {
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.agent.definitions.createDefinition(input);
		return { success: true, agent };
	});

	register("agent-definitions:update", async (data) => {
		guardString(data.name, "name");
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.agent.definitions.updateDefinition(data.name, input);
		return { success: true, agent };
	});

	register("agent-definitions:delete", async (data) => {
		guardString(data.name, "name");
		ctx.agent.definitions.deleteDefinition(data.name);
		return { success: true };
	});

	register("agent-definitions:install", async (data) => {
		guardString(data.name, "name");
		// 安装来源目前仅支持内置（builtin）；字段由 renderer-to-main 契约强制携带，
		// handler 必须校验而不是静默忽略——为将来扩展其他 source（npm/marketplace）留出枚举点。
		guardEnum(data.source, "source", INSTALL_SOURCES);
		const agent = await ctx.agent.definitions.installDefinition(data.name);
		return { success: true, agent };
	});

	register("agent-definitions:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.agent.subagentService.setAgentDefinitionEnabled(data.name, data.enabled);
		return { success: true };
	});

	register("skills:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.skill.setEnabled(data.name, data.enabled);
		return { success: true };
	});
};
