// ============================================================
// SessionChangesCard — 会话轮次「变更文件」收据
//
// 从当前轮次的编辑类工具中收集成功触及的文件。卡片只负责表达
// Agent 这一轮改了什么；点击文件行后由 Dock 查看器负责深度审阅。
// 头部右侧「审核」按钮：首次点击创建 Reviewer 子会话审查本轮变更，
// 之后点击直接打开已绑定的审核会话（绑定信息来自父会话 JSONL 的
// look.delegation.v1 记录）。
// ============================================================

import type { LookSessionEntry } from "@shared/types";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, FileDiff, Loader2, ShieldCheck } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAgentActions } from "../../hooks/useAgentActions";
import { type FileOperation, replayFileChanges } from "../../lib/changePatch";
import { agentsAtom } from "../../store/agentAtoms";
import { appStore } from "../../store/appStore";
import { confirmDockFileSwapIfDirty, dockedFileAtom, fileViewerDirtyAtom } from "../../store/atoms";
import { FileIcon } from "../workspace/FileIcon";
import { extractEditPatch, isEditTool } from "./message-elements/EditDiffPreview";

const MAX_VISIBLE_FILES = 3;

/** 审核子会话标题（与主进程 subagent-router REVIEW_TITLE 同步，勿单独改动）。 */
export const REVIEW_SESSION_TITLE = "审核本轮变更";

interface SessionChangesCardProps {
	entries: LookSessionEntry[];
	/** 当前 session 所属项目根目录，用于把工具相对路径解析为绝对路径。 */
	projectCwd?: string;
	/** 当前会话 ID，审核子会话以其为父会话创建。 */
	agentId: string;
	/** 本轮次标识（assistant 消息 entryId），审核子会话按它绑定，每轮互不串用。 */
	turnKey?: string;
}

/** 一个轮次中的变更文件，path 保持为项目相对路径供现有调用方使用。 */
export interface SessionChangedFile {
	path: string;
	relativePath: string;
	absolutePath: string | null;
	patch: string;
	added: number;
	deleted: number;
	/** 多次修改同一文件时，行数不是净变化，UI 应隐藏 +/− 统计。 */
	statsReliable: boolean;
	operationCount: number;
	canOpen: boolean;
}

interface ResolvedChangePath {
	relativePath: string;
	absolutePath: string | null;
}

function normalizePath(value: string): string {
	const raw = value.trim().replace(/\\/g, "/");
	if (!raw) return "";

	const drive = raw.match(/^[A-Za-z]:/);
	const absolute = raw.startsWith("/") || drive !== null;
	const prefix = drive ? `${drive[0]}/` : raw.startsWith("/") ? "/" : "";
	const body = drive ? raw.slice(2) : raw;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (!absolute) parts.push(part);
			continue;
		}
		parts.push(part);
	}
	if (prefix) return parts.length > 0 ? `${prefix}${parts.join("/")}` : prefix;
	return parts.join("/");
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function trimRoot(value: string): string {
	return value.length > 1 ? value.replace(/\/$/, "") : value;
}

function comparablePath(value: string): string {
	return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

function isInsideRoot(candidate: string, root: string): boolean {
	const c = comparablePath(trimRoot(candidate));
	const r = comparablePath(trimRoot(root));
	return c === r || c.startsWith(`${r}/`);
}

function resolveChangePath(rawPath: string, projectCwd: string): ResolvedChangePath {
	const normalized = normalizePath(rawPath);
	const root = trimRoot(normalizePath(projectCwd));
	if (!normalized) return { relativePath: rawPath, absolutePath: null };

	if (isAbsolutePath(normalized)) {
		if (root && isInsideRoot(normalized, root)) {
			const relativePath = root === "/" ? normalized.slice(1) : normalized.slice(root.length + 1);
			return { relativePath: relativePath || normalized, absolutePath: normalized };
		}
		// 项目外绝对路径仍可只读打开，查看器会走独立的 git/patch fallback。
		return { relativePath: normalized, absolutePath: normalized };
	}

	if (!root || normalized === ".." || normalized.startsWith("../")) {
		return { relativePath: normalized, absolutePath: null };
	}
	const absolutePath = normalizePath(`${root}/${normalized}`);
	if (!isInsideRoot(absolutePath, root)) return { relativePath: normalized, absolutePath: null };
	return { relativePath: normalized, absolutePath };
}

function splitDisplayPath(relativePath: string): { fileName: string; directory: string } {
	const slash = relativePath.lastIndexOf("/");
	if (slash < 0) return { fileName: relativePath, directory: "" };
	return { fileName: relativePath.slice(slash + 1), directory: relativePath.slice(0, slash + 1) };
}

function isFailedToolResult(result: unknown): boolean {
	return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
}

function toolResultMap(entries: readonly LookSessionEntry[]): Map<string, unknown> {
	const results = new Map<string, unknown>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		results.set(entry.message.toolCallId, entry.message);
	}
	return results;
}

/**
 * 从当前轮次收集成功编辑的文件（去重保序）。
 * 同一文件的所有 write/edit 操作按序重放合并为完整 patch + 精确统计
 * （replayFileChanges），卡片 +N -M 与查看器渲染共用同一 patch。
 */
export function collectChangedFiles(entries: LookSessionEntry[], projectCwd = ""): SessionChangedFile[] {
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			start = i + 1;
			break;
		}
	}
	const scopedEntries = entries.slice(start);
	const results = toolResultMap(scopedEntries);
	// 按文件收集本轮所有 write/edit 操作，聚合完成后统一重放成完整 patch（见 buildFiles）。
	const operationsByPath = new Map<string, FileOperation[]>();
	const resolvedByPath = new Map<string, ResolvedChangePath>();

	for (const entry of scopedEntries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (block?.type !== "toolCall" || !isEditTool(block.name)) continue;
			const args = block.arguments ?? {};
			const rawPath = typeof args.path === "string" ? args.path : "";
			if (!rawPath) continue;

			const result = typeof block.id === "string" ? results.get(block.id) : undefined;
			if (isFailedToolResult(result)) continue;

			const resolved = resolveChangePath(rawPath, projectCwd);
			const key = resolved.absolutePath ?? resolved.relativePath;
			// SDK result patch（args.edits 为空时供 replay 降级使用）
			const extracted = extractEditPatch(block.name, args, result, rawPath);
			const ops = operationsByPath.get(key);
			if (ops) {
				ops.push({ tool: block.name, args, patchFallback: extracted?.patch });
				continue;
			}
			operationsByPath.set(key, [{ tool: block.name, args, patchFallback: extracted?.patch }]);
			resolvedByPath.set(key, resolved);
		}
	}

	// 聚合完成：按文件重放全部操作 → 完整 patch + 精确统计（卡片与查看器共用同一 patch）。
	const files: SessionChangedFile[] = [];
	for (const [key, operations] of operationsByPath) {
		const resolved = resolvedByPath.get(key);
		if (!resolved) continue;
		const replayed = replayFileChanges(resolved.relativePath, operations);
		files.push({
			path: resolved.relativePath,
			relativePath: resolved.relativePath,
			absolutePath: resolved.absolutePath,
			patch: replayed?.patch ?? "",
			added: replayed?.added ?? 0,
			deleted: replayed?.deleted ?? 0,
			// 重放完全成功（无 oldText 匹配失败/非近似）→ 统计可靠；否则隐藏 +/−。
			statsReliable: replayed !== null && !replayed.unmatched && !replayed.approximate,
			operationCount: operations.length,
			canOpen: resolved.absolutePath !== null,
		});
	}
	return files;
}

function formatStats(file: SessionChangedFile) {
	if (!file.statsReliable) return null;
	if (file.added === 0 && file.deleted === 0) return null;
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
			{file.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>}
			{file.deleted > 0 && <span className="text-red-600 dark:text-red-400">-{file.deleted}</span>}
		</span>
	);
}

/** 头部汇总：+N −M 数字 + 5 格比例块（绿=新增占比，红=删除占比），一眼读出本轮增删比。 */
function DiffstatSummary({ added, deleted }: { added: number; deleted: number }) {
	const total = added + deleted;
	if (total === 0) return null;
	let addBlocks = Math.round((added / total) * 5);
	if (added > 0 && addBlocks === 0) addBlocks = 1;
	if (deleted > 0 && addBlocks === 5) addBlocks = 4;
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			<span className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
				{added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
				{deleted > 0 && <span className="text-red-600 dark:text-red-400">-{deleted}</span>}
			</span>
			<span className="flex items-center gap-px" aria-hidden>
				{Array.from({ length: 5 }, (_, i) => (
					<span
						key={i < addBlocks ? `add-${i}` : `del-${i}`}
						className={`h-2 w-[3px] rounded-[1px] ${i < addBlocks ? "bg-emerald-500/80" : "bg-red-500/70"}`}
					/>
				))}
			</span>
		</span>
	);
}

const SessionChangesCard = memo(function SessionChangesCard({
	entries,
	projectCwd = "",
	agentId,
	turnKey,
}: SessionChangesCardProps) {
	const { t } = useTranslation();
	const { handleSelectAgent } = useAgentActions();
	const dockedFile = useAtomValue(dockedFileAtom);
	const agents = useAtomValue(agentsAtom);
	// 子会话（审核子会话等）内的变更卡片不提供审核按钮，避免无限递归创建子子会话。
	const isSubagentSession = agents.some((agent) => agent.id === agentId && agent.isSubagentSession === true);
	const [expanded, setExpanded] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	// 命中已有审核会话时本地记住；刷新后由主进程按 turnKey 查找兜底，不会重复创建。
	const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
	// 已注入委派指令（子会话创建中）：再次点击不再重复注入，提示稍后再试。
	const [reviewDispatched, setReviewDispatched] = useState(false);
	const files = useMemo(() => collectChangedFiles(entries, projectCwd), [entries, projectCwd]);

	const handleReview = useCallback(async () => {
		if (reviewing) return;
		// 本地已绑定：直接打开审核子会话，不重复创建。
		if (reviewSessionId) {
			await handleSelectAgent(reviewSessionId);
			return;
		}
		// 轮次隔离：turnKey 编入审核会话标题（如「审核本轮变更 (entry-a1)」），
		// 子会话 agentName 随之带轮次标识，delegation 匹配天然不跨轮串用。
		const effectiveTitle = turnKey ? `${REVIEW_SESSION_TITLE} (${turnKey})` : REVIEW_SESSION_TITLE;
		setReviewing(true);
		try {
			// 1) 查询该轮是否已有审核子会话（主进程按 delegation agentName 匹配）。
			const result = await window.look.reviewChanges({
				parentSessionId: agentId,
				title: effectiveTitle,
				turnKey: turnKey ?? "",
			});
			if (!result?.success) throw new Error(result?.error ?? "Failed to find review session");
			if (result.childSessionId) {
				// 已有审核会话：直接打开（不重复委派）。
				setReviewSessionId(result.childSessionId);
				await handleSelectAgent(result.childSessionId);
				toast.success(t("changesCard.reviewOpened", "已打开审核会话"));
				return;
			}
			// 2) 已注入过指令但子会话尚未创建完成：不重复注入，提示等待。
			if (reviewDispatched) {
				toast.info(t("changesCard.reviewPending", "审核会话创建中，请稍后再试"));
				return;
			}
			// 3) 未命中且未注入过：注入 /subagent:reviewer 委派指令，主 Agent 调用 subagent 工具
			//    创建审核子会话（消息流出现 subagent 工具卡，执行可见）。
			const fileList = files.map((file) => `- ${file.relativePath}（+${file.added} -${file.deleted}）`).join("\n");
			const instruction = `/subagent:reviewer 请审查本轮代码变更，使用 subagent 工具（title 设为「${effectiveTitle}」）。变更文件清单：\n${fileList}`;
			const sent = await window.look.sendMessage(agentId, instruction);
			if (!sent?.success) throw new Error(sent?.error ?? "Failed to dispatch review");
			setReviewDispatched(true);
			toast.success(t("changesCard.reviewDispatched", "已发起审核，主 Agent 将创建审核子会话"));
		} catch (error) {
			toast.error(
				t("changesCard.reviewFailed", {
					message: error instanceof Error ? error.message : String(error),
					defaultValue: "创建审核会话失败：{{message}}",
				}),
			);
		} finally {
			setReviewing(false);
		}
	}, [reviewing, reviewSessionId, reviewDispatched, handleSelectAgent, agentId, turnKey, files, t]);

	if (files.length === 0) return null;

	const visibleFiles = expanded ? files : files.slice(0, MAX_VISIBLE_FILES);
	const hasMore = files.length > MAX_VISIBLE_FILES;
	const allStatsReliable = files.every((file) => file.statsReliable);
	const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
	const totalDeleted = files.reduce((sum, file) => sum + file.deleted, 0);
	const totalOperations = files.reduce((sum, file) => sum + file.operationCount, 0);

	return (
		<section
			data-testid="session-changes-card"
			aria-label={t("changesCard.title", "本轮变更")}
			className="relative w-full overflow-hidden rounded-lg border border-hairline bg-foreground/[0.025] px-3 py-2.5"
		>
			<div className="flex items-center gap-2">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-500">
					<FileDiff className="size-3.5" aria-hidden />
				</span>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="shrink-0 text-[12px] font-medium leading-tight text-foreground">
						{t("changesCard.title", "本轮变更")}
					</span>
					<span className="truncate text-[10px] leading-tight text-muted-foreground/70">
						{t(files.length === 1 ? "changesCard.fileCountOne" : "changesCard.fileCountMany", {
							count: files.length,
							defaultValue: "{{count}} 个文件",
						})}
						{" · "}
						{t("changesCard.saved", "已写入工作区")}
					</span>
				</div>
				{allStatsReliable && (totalAdded > 0 || totalDeleted > 0) ? (
					<DiffstatSummary added={totalAdded} deleted={totalDeleted} />
				) : totalOperations > files.length ? (
					<span className="shrink-0 text-[10px] leading-none text-muted-foreground/70">
						{t("changesCard.operationCount", {
							count: totalOperations,
							defaultValue: "{{count}} 次修改",
						})}
					</span>
				) : null}
				{!isSubagentSession && (
					<button
						type="button"
						onClick={handleReview}
						disabled={reviewing}
						aria-label={
							reviewing
								? t("changesCard.reviewRunning", "正在创建审核会话…")
								: reviewSessionId
									? t("changesCard.reviewOpen", "查看审核")
									: t("changesCard.review", "审核")
						}
						title={reviewSessionId ? t("changesCard.reviewOpen", "查看审核") : t("changesCard.review", "审核")}
						className="flex shrink-0 items-center gap-1 rounded-md border border-hairline bg-foreground/[0.03] px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
					>
						{reviewing ? (
							<Loader2 className="size-3 animate-spin" aria-hidden />
						) : (
							<ShieldCheck className="size-3" aria-hidden />
						)}
						{reviewing
							? t("changesCard.reviewRunning", "正在创建审核会话…")
							: reviewSessionId
								? t("changesCard.reviewOpen", "查看审核")
								: t("changesCard.review", "审核")}
					</button>
				)}
			</div>

			<div className="mt-1.5">
				{visibleFiles.map((file) => {
					const { fileName, directory } = splitDisplayPath(file.relativePath);
					const active = file.absolutePath !== null && dockedFile?.absolutePath === file.absolutePath;
					const stats = formatStats(file);
					const iconNode = {
						name: fileName,
						path: file.relativePath,
						absolutePath: file.absolutePath ?? file.relativePath,
						type: "file" as const,
					};
					const ariaLabel = t("changesCard.fileAria", {
						path: file.relativePath,
						defaultValue: "打开 {{path}} 的变更详情",
					});

					return (
						<button
							key={`${file.relativePath}-${file.absolutePath ?? "unresolved"}`}
							type="button"
							disabled={!file.canOpen}
							onClick={() => {
								if (!file.absolutePath) return;
								// Dock 面板已有未保存编辑时先确认，避免静默覆盖草稿（与 requestViewFileAtom 一致）。
								if (
									appStore.get(dockedFileAtom) &&
									!confirmDockFileSwapIfDirty(() => appStore.get(fileViewerDirtyAtom))
								)
									return;
								appStore.set(dockedFileAtom, {
									absolutePath: file.absolutePath,
									diffPatch: file.patch,
								});
							}}
							title={file.canOpen ? ariaLabel : t("changesCard.pathUnavailable", "无法定位此文件")}
							aria-label={ariaLabel}
							className={`group relative flex w-full items-center gap-2 py-2 text-left transition-colors ${
								active
									? "bg-foreground/[0.06] text-foreground"
									: file.canOpen
										? "text-foreground/90 hover:bg-foreground/[0.04]"
										: "cursor-default text-muted-foreground/50"
							} ${active ? "before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-emerald-500" : ""}`}
						>
							<FileIcon node={iconNode} className="size-3.5 shrink-0" />
							<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
								<span className="max-w-[55%] shrink-0 truncate text-[12px] font-medium leading-tight">
									{fileName || file.relativePath}
								</span>
								{directory && (
									<span className="min-w-0 truncate font-mono text-[11px] leading-tight text-muted-foreground/60">
										{directory}
									</span>
								)}
							</span>
							{stats ??
								(file.operationCount > 1 ? (
									<span className="shrink-0 font-mono text-[10px] text-muted-foreground/65">
										{t("changesCard.operationShort", {
											count: file.operationCount,
											defaultValue: "{{count}} 次",
										})}
									</span>
								) : null)}
							{file.canOpen ? (
								<ChevronRight
									className="size-3.5 shrink-0 text-muted-foreground/45 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/70"
									aria-hidden
								/>
							) : (
								<span className="shrink-0 text-[10px] text-muted-foreground/40">—</span>
							)}
						</button>
					);
				})}
			</div>

			{hasMore && (
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					className="mt-1 flex w-full items-center justify-center gap-1 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
				>
					{expanded ? (
						<ChevronDown className="size-3" aria-hidden />
					) : (
						<ChevronRight className="size-3" aria-hidden />
					)}
					{expanded
						? t("changesCard.collapse", "收起")
						: t("changesCard.moreFiles", {
								count: files.length - MAX_VISIBLE_FILES,
								defaultValue: "展开其余 {{count}} 个文件",
							})}
				</button>
			)}
		</section>
	);
});

export default SessionChangesCard;
