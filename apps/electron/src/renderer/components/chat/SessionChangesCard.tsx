// ============================================================
// SessionChangesCard — 会话结束「变更文件」卡片
//
// 从会话消息中收集编辑类工具（edit/write/apply_diff/create）涉及的
// 文件（含 diff patch，用 extractEditPatch 从工具参数构造，不依赖
// git）。点击文件 → 就地向下展开该文件的 diff 预览（@pierre/diffs
// Proma 同款），再次点击收起。
// ============================================================

// 注册 <diffs-container> custom element（sideEffects 文件，需显式 import）。
import "@pierre/diffs/dist/components/web-components.js";
import { PatchDiff } from "@pierre/diffs/react";
import type { LookSessionEntry } from "@shared/types";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { extractEditPatch, isEditTool } from "./message-elements/EditDiffPreview";

interface SessionChangesCardProps {
	entries: LookSessionEntry[];
}

/** 会话中一个变更文件（路径 + diff patch + 行统计）。 */
export interface SessionChangedFile {
	path: string;
	patch: string;
	added: number;
	deleted: number;
}

/** 从 patch 文本统计 +/- 行数（排除头行）。 */
function countPatchLines(patch: string): { added: number; deleted: number } {
	let added = 0;
	let deleted = 0;
	for (const line of patch.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
	}
	return { added, deleted };
}

/**
 * 从会话条目收集编辑类工具涉及的文件及其 diff patch（去重保序）。
 * patch 优先用工具 result（若已在同一条目），否则从 args 构造。
 */
export function collectChangedFiles(entries: LookSessionEntry[]): SessionChangedFile[] {
	const files: SessionChangedFile[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "toolCall") continue;
			if (!isEditTool(block.name)) continue;
			const args = block.arguments ?? {};
			const p = typeof args.path === "string" ? args.path : "";
			if (!p || seen.has(p)) continue;
			const patch = extractEditPatch(block.name, args, undefined, p)?.patch ?? "";
			const { added, deleted } = countPatchLines(patch);
			seen.add(p);
			files.push({ path: p, patch, added, deleted });
		}
	}
	return files;
}

const SessionChangesCard = memo(function SessionChangesCard({ entries }: SessionChangesCardProps) {
	const { t } = useTranslation();
	const { tone } = useLookTheme();
	const isDark = tone === "dark";
	const files = useMemo(() => collectChangedFiles(entries), [entries]);
	const [expandedPath, setExpandedPath] = useState<string | null>(null);

	if (files.length === 0) return null;

	const expanded = files.find((f) => f.path === expandedPath) ?? null;

	return (
		<div className="flex flex-col gap-1 rounded-lg border border-hairline bg-foreground/[0.02] px-3 py-2">
			<div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
				<FileDiff className="size-3 text-emerald-500" aria-hidden />
				{t("changesCard.title", "本次会话变更")}
				<span className="font-mono text-[10px] text-muted-foreground/70">{files.length}</span>
			</div>
			<div className="flex flex-wrap gap-1">
				{files.map((file) => {
					const isOpen = file.path === expandedPath;
					return (
						<button
							key={file.path}
							type="button"
							onClick={() => setExpandedPath(isOpen ? null : file.path)}
							aria-expanded={isOpen}
							title={isOpen ? t("changesCard.collapse", "收起") : t("changesCard.expand", "展开变更内容")}
							className={`flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
								isOpen
									? "border-foreground/25 bg-foreground/[0.06] text-foreground"
									: "border-hairline bg-background/60 text-muted-foreground hover:border-foreground/20 hover:text-foreground"
							}`}
						>
							{isOpen ? (
								<ChevronDown className="size-2.5 shrink-0 text-emerald-500" aria-hidden />
							) : (
								<ChevronRight className="size-2.5 shrink-0 text-emerald-500" aria-hidden />
							)}
							<span className="truncate">{file.path}</span>
							{(file.added > 0 || file.deleted > 0) && (
								<span className="shrink-0 font-mono text-[9px]">
									{file.added > 0 && (
										<span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>
									)}
									{file.deleted > 0 && (
										<span className="text-red-600 dark:text-red-400"> -{file.deleted}</span>
									)}
								</span>
							)}
						</button>
					);
				})}
			</div>
			{expanded && (
				<div className="overflow-hidden rounded-md ring-1 ring-hairline">
					<PatchDiff
						patch={expanded.patch}
						disableWorkerPool
						renderCustomHeader={() => null}
						options={{
							themeType: isDark ? "dark" : "light",
							diffStyle: "unified",
							hunkSeparators: "simple",
							disableBackground: false,
							// 与文件查看器 FileDiff 一致的变更行标记（bars）
							diffIndicators: "bars",
						}}
					/>
				</div>
			)}
		</div>
	);
});

export default SessionChangesCard;
