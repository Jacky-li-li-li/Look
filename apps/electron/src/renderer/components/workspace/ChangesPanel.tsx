// ============================================================
// ChangesPanel — 右侧面板「变更」tab：文件变更列表（点击向下展开 diff）
//
// 加载当前项目的 git diff（GitService.getDiff 按文件分组），
// 列表展示变更文件（状态图标 + 路径 + 绿/红行数）。点击文件行 →
// 该行下方就地展开 diff 预览（@pierre/diffs PatchDiff，Proma 同款，
// 无文件头），再次点击收起。展开区提供「打开文件」按钮。
// ============================================================

// 注册 <diffs-container> custom element（sideEffects 文件，需显式 import）。
import "@pierre/diffs/dist/components/web-components.js";
import { Button } from "@look/ui/components/ui/button";
import { PatchDiff } from "@pierre/diffs/react";
import type { GitDiffFile } from "@shared/types";
import { ChevronDown, ChevronRight, FileDiff, FilePlus2, FileX2, FolderOpen, LoaderCircle } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { appStore } from "../../store/appStore";
import { dockedFileAtom } from "../../store/atoms";

const STATUS_ICON = {
	added: FilePlus2,
	modified: FileDiff,
	deleted: FileX2,
	untracked: FilePlus2,
} as const;

const STATUS_COLOR = {
	added: "text-emerald-500",
	modified: "text-amber-500",
	deleted: "text-red-500",
	untracked: "text-emerald-500",
} as const;

interface ChangesPanelProps {
	projectId: string;
	/** 项目根目录（用于把 diff 相对路径拼成绝对路径打开文件查看器）。 */
	cwd: string;
}

const ChangesPanel = memo(function ChangesPanel({ projectId, cwd }: ChangesPanelProps) {
	const { t } = useTranslation();
	const { tone } = useLookTheme();
	const isDark = tone === "dark";
	const [files, setFiles] = useState<GitDiffFile[]>([]);
	const [loading, setLoading] = useState(false);
	const [expandedPath, setExpandedPath] = useState<string | null>(null);

	// 加载 diff 列表（切换项目/tab 时）
	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;
		setLoading(true);
		window.look
			.getProjectGitDiff(projectId)
			.then((result) => {
				if (cancelled) return;
				setFiles(result?.success ? result.files : []);
				setExpandedPath(null);
			})
			.catch((err) => console.warn("[ChangesPanel] getProjectGitDiff failed:", err))
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	const expanded = files.find((f) => f.path === expandedPath) ?? null;

	return (
		<div className="h-full overflow-y-auto">
			<div className="min-w-0 w-full py-1">
				{loading ? (
					<div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
						<LoaderCircle className="size-3 animate-spin" />
						{t("changes.loading", "加载中…")}
					</div>
				) : files.length === 0 ? (
					<div className="px-3 py-2 text-[11px] text-muted-foreground">{t("changes.empty", "暂无文件变更")}</div>
				) : (
					files.map((file) => {
						const Icon = STATUS_ICON[file.status];
						const isOpen = file.path === expandedPath;
						// 主行展示文件名，副行展示所在目录路径（git 相对路径，/ 分隔）
						const slash = file.path.lastIndexOf("/");
						const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
						const fileDir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
						return (
							<div key={file.path} className="flex flex-col">
								<button
									type="button"
									onClick={() => setExpandedPath(isOpen ? null : file.path)}
									aria-expanded={isOpen}
									className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors ${
										isOpen ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]"
									}`}
								>
									{isOpen ? (
										<ChevronDown className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
									) : (
										<ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
									)}
									<Icon className={`size-3 shrink-0 ${STATUS_COLOR[file.status]}`} aria-hidden />
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="truncate text-[11px] leading-none font-medium">{fileName}</span>
										{fileDir && (
											<span
												className="truncate font-mono text-[10px] leading-none text-muted-foreground/60"
												title={file.path}
											>
												{fileDir}
											</span>
										)}
									</span>
									<span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
										{file.addedLines > 0 && (
											<span className="text-emerald-600 dark:text-emerald-400">+{file.addedLines}</span>
										)}
										{file.deletedLines > 0 && (
											<span className="text-red-600 dark:text-red-400"> -{file.deletedLines}</span>
										)}
									</span>
								</button>
								{isOpen && expanded && (
									<div className="mx-3 mb-2 rounded-md ring-1 ring-hairline">
										<div className="flex items-center justify-between border-b border-hairline px-2 py-1">
											<span className="truncate font-mono text-[10px] text-muted-foreground/70">
												{t("changes.diff", "Diff")}
											</span>
											<Button
												variant="ghost"
												size="icon-xs"
												className="shrink-0"
												aria-label={t("changes.openFile", "打开文件")}
												title={t("changes.openFile", "打开文件")}
												onClick={() =>
													appStore.set(dockedFileAtom, {
														absolutePath: `${cwd.replace(/\/$/, "")}/${expanded.path}`,
														diffPatch: expanded.patch,
													})
												}
											>
												<FolderOpen className="size-3" />
											</Button>
										</div>
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
												// 长行自动换行，适配窄面板宽度
												overflow: "wrap",
											}}
										/>
									</div>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
});

export default ChangesPanel;
