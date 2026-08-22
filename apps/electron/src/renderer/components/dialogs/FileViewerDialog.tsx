// ============================================================
// FileViewerDialog — 文件查看器对话框（主壳）
//
// 由 viewingFileAtom 驱动：工作区文件树 / 聊天内联路径 / @ 引用芯片
// 三个入口设置 atom 即可打开。Markdown 支持预览 / 编辑切换与保存；
// 图片(png/jpg/gif/webp/svg 等)直接预览；其他文本文件走 shiki 双主题
// 高亮；不可预览的二进制文件显示提示 + Finder 按钮。
//
// 三种部署模式（props 契约不变，见 FileViewerDialogProps）：
//   - floating（默认）：非模态浮窗，可拖拽/缩放
//   - windowMode：独立原生窗口，铺满，关闭即关窗
//   - dockMode：主窗口右侧 Dock 面板，占满父容器，导航/关闭回调由父组件处理
//
// 子模块（拆自本文件，按关注点分离）：
//   - fileViewerUtils：纯函数（路径展示/边界判断/字节格式化）
//   - useHighlighter：shiki 单例 + 异步高亮 hook
//   - useFileContent：加载/HEAD/编辑草稿/返回栈
//   - FileViewerToc：Markdown 目录导航
//   - useFloatingPanel：浮窗拖拽/缩放
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@look/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { AttachmentRef, FileTreeNode } from "@shared/types";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	ArrowLeft,
	Copy,
	ExternalLink,
	Eye,
	FileWarning,
	FolderOpen,
	MoreHorizontal,
	PanelRightOpen,
	Pencil,
	RefreshCw,
	Save,
	X,
} from "lucide-react";
import { type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useLookTheme } from "../../hooks/useLookTheme";
import { resolveFileLanguage } from "../../lib/fileLanguage";
import { extractHeadings } from "../../lib/markdownToc";
import { activeProjectAtom, fileViewerDirtyAtom, viewingFileAtom } from "../../store/atoms";
// 注册 <diffs-container> custom element（sideEffects 文件，需显式 import）。
import "@pierre/diffs/dist/components/web-components.js";
import { ErrorBoundary } from "@look/ui/components/ErrorBoundary";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, PatchDiff } from "@pierre/diffs/react";
import { FileIcon } from "../workspace/FileIcon";
import { FileViewerToc, FileViewerTocExpandButton } from "./file-viewer/FileViewerToc";
import { formatBytes, shortenPath, truncateMiddle } from "./file-viewer/fileViewerUtils";
import { useFileContent } from "./file-viewer/useFileContent";
import { useFloatingPanel } from "./file-viewer/useFloatingPanel";
import { useHighlightedHtml } from "./file-viewer/useHighlighter";

const LookMarkdown = lazy(() => import("../markdown/LookMarkdown"));

interface FileViewerDialogProps {
	/** 独立原生窗口模式：铺满整个窗口，禁用拖动/缩放，关闭即关窗。 */
	windowMode?: boolean;
	/** 主窗口右侧 Dock 面板模式：占满父容器，禁用拖动/缩放，关闭/导航回调由父组件处理。 */
	dockMode?: boolean;
	/** Dock 模式当前文件路径（替代 viewingFileAtom 驱动）。 */
	dockPath?: string | null;
	/** Dock 模式携带的 diff patch（从「变更」面板打开时显示该文件 diff）。 */
	dockDiffPatch?: string;
	/** Dock 模式携带的粘贴附件元数据（附件模式：读写走 attachment:* IPC）。 */
	dockAttachment?: AttachmentRef | null;
	/** Dock 模式内返回栈跳转新文件时回调（更新 dockedFileAtom）。 */
	onDockNavigate?: (path: string) => void;
	/** Dock 模式关闭回调（清空 dockedFileAtom）。 */
	onDockClose?: () => void;
	/** Dock 模式"弹出为独立窗口"回调。 */
	onDockUndock?: () => void;
}

export default function FileViewerDialog({
	windowMode = false,
	dockMode = false,
	dockPath,
	dockDiffPatch,
	dockAttachment,
	onDockNavigate,
	onDockClose,
	onDockUndock,
}: FileViewerDialogProps) {
	const { t } = useTranslation();
	const [viewingFile, setViewingFile] = useAtom(viewingFileAtom);
	const { scheme: viewerScheme } = useLookTheme();
	const diffPatch = dockMode ? dockDiffPatch : viewingFile?.diffPatch;
	const activeProject = useAtomValue(activeProjectAtom);

	// 路径来源抽象：Dock 模式由 dockPath 驱动，其余由 viewingFileAtom 驱动
	const absolutePath = dockMode ? (dockPath ?? null) : (viewingFile?.absolutePath ?? null);
	const hasFile = dockMode ? !!dockPath : !!viewingFile;
	// 粘贴附件模式
	const attachment: AttachmentRef | null = dockMode ? (dockAttachment ?? null) : (viewingFile?.attachment ?? null);
	const isAttachment = attachment !== null;

	const {
		loadState,
		oldContent,
		triggerReload,
		editMode,
		setEditMode,
		draft,
		setDraft,
		savedContent,
		setSavedContent,
		patchDismissed,
		setPatchDismissed,
		backStack,
		markBackNav,
		popBackStack,
	} = useFileContent({
		absolutePath,
		diffPatch,
		activeProjectCwd: activeProject?.cwd ?? null,
		activeProjectId: activeProject?.id ?? null,
		attachment,
	});

	const {
		pos: panelPos,
		size: panelSize,
		handleDragStart,
		handleResizeStart,
	} = useFloatingPanel(!windowMode && !dockMode);
	const panelRef = useRef<HTMLDivElement>(null);

	// 路径写入抽象：返回栈跳转等场景统一入口
	const setCurrentFile = useCallback(
		(path: string) => {
			if (dockMode) onDockNavigate?.(path);
			else setViewingFile({ absolutePath: path });
		},
		[dockMode, onDockNavigate, setViewingFile],
	);

	const basename = useMemo(() => absolutePath?.split(/[\\/]/).pop() ?? "", [absolutePath]);
	const isMarkdown = /\.(md|markdown)$/i.test(basename);
	const language = useMemo(() => (basename ? resolveFileLanguage(basename) : null), [basename]);
	const displayPath = useMemo(() => (absolutePath ? truncateMiddle(shortenPath(absolutePath)) : ""), [absolutePath]);
	const iconNode = useMemo<FileTreeNode>(
		() => ({ name: basename, path: absolutePath ?? "", absolutePath: absolutePath ?? "", type: "file" }),
		[basename, absolutePath],
	);

	const textData = loadState.status === "text" ? loadState : null;
	const diffExpected = diffPatch !== undefined && textData !== null && !patchDismissed;
	const truncated = textData?.truncated ?? false;
	const dirty = draft !== savedContent;
	const inProject =
		loadState.status === "text" || loadState.status === "image" || loadState.status === "binary"
			? loadState.inProject
			: true;
	const canEdit = (isMarkdown || isAttachment) && !truncated && inProject;

	const previewRef = useRef<HTMLDivElement>(null);
	const tocHeadings = useMemo(
		() => (textData && isMarkdown ? extractHeadings(textData.content) : []),
		[textData, isMarkdown],
	);
	const showToc = textData !== null && isMarkdown && !editMode && tocHeadings.length >= 2;
	const [tocCollapsed, setTocCollapsed] = useState(false);
	const [tocWidth, setTocWidth] = useState(176);

	const { highlightedHtml, highlightFailed } = useHighlightedHtml(
		textData && !isMarkdown ? textData.content : null,
		!isMarkdown ? language : null,
	);

	const [saving, setSaving] = useState(false);

	// ── 关闭/导航/保存 操作 ──

	const requestClose = useCallback(() => {
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		if (windowMode) {
			window.close();
			return;
		}
		if (dockMode) {
			onDockClose?.();
			return;
		}
		setViewingFile(null);
	}, [dirty, windowMode, dockMode, onDockClose, setViewingFile, t]);

	const handleDockToMain = useCallback(() => {
		if (!absolutePath) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		void window.look.dockFileViewer(absolutePath, viewingFile?.diffPatch);
	}, [absolutePath, dirty, viewingFile, t]);

	const handleUndock = useCallback(() => {
		if (!absolutePath) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		onDockUndock?.();
	}, [absolutePath, dirty, onDockUndock, t]);

	const handleRefresh = useCallback(() => {
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		triggerReload();
	}, [dirty, triggerReload, t]);

	const handleBack = useCallback(() => {
		const target = backStack[backStack.length - 1];
		if (!target) return;
		if (dirty && !window.confirm(t("fileViewer.unsavedConfirm"))) return;
		markBackNav();
		// 出栈：目标路径若与当前相同，导航 effect 不触发、backNavRef 无人消费，
		// 栈也不缩——不弹会让按钮永不消失并让卡住的标志吞掉下一次真实导航。
		popBackStack();
		setCurrentFile(target);
	}, [backStack, dirty, setCurrentFile, t, markBackNav, popBackStack]);

	const handleCopyPath = useCallback(() => {
		if (!absolutePath) return;
		void navigator.clipboard.writeText(absolutePath);
		toast.success(t("fileViewer.copied"));
	}, [absolutePath, t]);

	const handleReveal = useCallback(() => {
		if (absolutePath) window.look.revealInFinder(absolutePath);
	}, [absolutePath]);

	const handleSave = useCallback(async () => {
		if (!absolutePath || saving || !dirty || truncated) return;
		setSaving(true);
		try {
			const result = isAttachment
				? await window.look.updateAttachment(attachment.projectId, attachment.sessionId, attachment.name, draft)
				: await window.look.writeFileContent(absolutePath, draft);
			if (!result.success) throw new Error(result.error);
			setSavedContent(draft);
			// 重读文件与 HEAD 版本：diff 立即反映保存后的磁盘内容
			triggerReload();
			// 入口 patch 是打开时的快照：保存后退出 patch 视图，避免显示陈旧 diff
			setPatchDismissed(true);
			toast.success(t("fileViewer.saved"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("fileViewer.loadFailed"));
		} finally {
			setSaving(false);
		}
	}, [
		absolutePath,
		saving,
		dirty,
		truncated,
		draft,
		t,
		isAttachment,
		attachment,
		triggerReload,
		setPatchDismissed,
		setSavedContent,
	]);

	const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void handleSave();
		}
	};

	// ── 副作用 ──

	// 独立窗口模式：原生标题栏同步当前文件名
	useEffect(() => {
		if (!windowMode) return;
		document.title = absolutePath ? `${basename} — Look` : t("fileViewer.windowTitle");
	}, [windowMode, absolutePath, basename, t]);

	// 脏状态镜像到全局 atom：非模态下外部入口据此决定先确认
	const setFileViewerDirty = useSetAtom(fileViewerDirtyAtom);
	useEffect(() => {
		setFileViewerDirty(dirty);
	}, [dirty, setFileViewerDirty]);

	// Esc：仅当焦点在浮窗内时关闭，不劫持聊天输入的 Esc
	useEffect(() => {
		if (!hasFile) return;
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape" && panelRef.current?.contains(document.activeElement)) {
				requestClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [hasFile, requestClose]);

	// consumeBackNav 由 useFileContent 内部在入栈逻辑里消费（见 hook effect），
	// 主壳无需重复调用——重复消费会把正常导航误判为返回导航。

	// ── 渲染 ──

	const renderDiffView = (oldContentText: string, newContentText: string) => (
		<div className="min-h-0 flex-1 overflow-auto">
			<FileDiff
				fileDiff={parseDiffFromFile(
					{ name: basename || "file", contents: oldContentText },
					{ name: basename || "file", contents: newContentText },
				)}
				disableWorkerPool
				renderCustomHeader={() => null}
				className="h-full"
				options={{
					themeType: viewerScheme,
					diffStyle: "unified",
					hunkSeparators: "line-info",
					disableBackground: false,
					diffIndicators: "bars",
					lineDiffType: "none",
					overflow: "scroll",
				}}
			/>
		</div>
	);

	const renderPatchView = (patch: string) => (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-auto">
				<ErrorBoundary
					fallback={
						<pre className="m-0 whitespace-pre-wrap break-all p-4 font-mono text-xs text-muted-foreground">
							{patch}
						</pre>
					}
				>
					<PatchDiff
						patch={patch}
						disableWorkerPool
						renderCustomHeader={() => null}
						options={{
							themeType: viewerScheme,
							diffStyle: "unified",
							hunkSeparators: "simple",
							disableBackground: false,
							diffIndicators: "bars",
							overflow: "wrap",
						}}
					/>
				</ErrorBoundary>
			</div>
		</div>
	);

	if (!hasFile) {
		if (!windowMode) return null;
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-popover text-sm text-muted-foreground">
				{t("fileViewer.emptyHint")}
			</div>
		);
	}

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label={basename}
			className={
				windowMode
					? "fixed inset-0 flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground"
					: dockMode
						? "flex h-full min-w-0 flex-col overflow-hidden bg-popover text-sm text-popover-foreground"
						: "fixed z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
			}
			style={
				windowMode || dockMode
					? undefined
					: { left: panelPos.x, top: panelPos.y, width: panelSize.width, height: panelSize.height }
			}
		>
			{/* 标题栏 */}
			<div
				className={
					(windowMode || dockMode
						? "flex shrink-0 select-none flex-col gap-1 border-b px-4 py-2"
						: "flex shrink-0 cursor-move touch-none select-none flex-col gap-1 border-b px-4 py-2") +
					(editMode ? " border-b-2 border-primary/40" : "")
				}
				onPointerDown={windowMode || dockMode ? undefined : handleDragStart}
			>
				<div className="flex items-center gap-2">
					{backStack.length > 0 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon-xs" onClick={handleBack} aria-label={t("fileViewer.back")}>
									<ArrowLeft className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("fileViewer.back")}</TooltipContent>
						</Tooltip>
					)}
					<FileIcon node={iconNode} className="size-4 shrink-0" />
					<h2 className="truncate font-heading text-[13px] leading-none font-medium">{basename}</h2>
					{!inProject && (
						<span className="shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
							{t("fileViewer.readOnly")}
						</span>
					)}
					{dirty && (
						<span
							className="size-1.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/20"
							aria-hidden="true"
						/>
					)}
					<div className="ml-auto flex shrink-0 items-center gap-1">
						{canEdit && (
							<>
								<Button
									variant="outline"
									size="xs"
									onClick={() => setEditMode((v) => !v)}
									aria-pressed={editMode}
									title={editMode ? t("fileViewer.preview") : t("fileViewer.edit")}
								>
									{editMode ? <Eye className="size-3" /> : <Pencil className="size-3" />}
									{editMode ? t("fileViewer.preview") : t("fileViewer.edit")}
								</Button>
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="inline-flex">
											<Button
												variant={dirty ? "outline" : "ghost"}
												size="icon-xs"
												onClick={() => void handleSave()}
												disabled={!dirty || saving}
												aria-label={t("fileViewer.save")}
												className={cn(
													dirty && "text-amber-500 hover:text-amber-500/90 hover:bg-amber-500/10",
												)}
											>
												<Save className="size-3.5" />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="bottom">{t("fileViewer.save")}</TooltipContent>
								</Tooltip>
							</>
						)}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("fileViewer.moreActions")}
									title={t("fileViewer.moreActions")}
								>
									<MoreHorizontal className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={handleCopyPath}>
									<Copy className="mr-2 size-3.5" />
									{t("fileViewer.copyPath")}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={handleReveal}>
									<FolderOpen className="mr-2 size-3.5" />
									{t("fileViewer.revealInFinder")}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={handleRefresh}>
									<RefreshCw className="mr-2 size-3.5" />
									{t("fileViewer.refresh")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						{windowMode && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-xs"
										onClick={handleDockToMain}
										aria-label={t("fileViewer.dockToMain")}
									>
										<PanelRightOpen className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{t("fileViewer.dockToMain")}</TooltipContent>
							</Tooltip>
						)}
						{dockMode && !isAttachment && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-xs"
										onClick={handleUndock}
										aria-label={t("fileViewer.undock")}
									>
										<ExternalLink className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{t("fileViewer.undock")}</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={requestClose}
									aria-label={t("fileViewer.close")}
								>
									<X className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("fileViewer.close")}</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<p className="truncate font-mono text-[11px] text-muted-foreground/80" title={absolutePath ?? undefined}>
					{displayPath}
				</p>
			</div>
			<div className="flex min-h-0 flex-1 flex-col" aria-label={t("fileViewer.viewFile")}>
				{diffExpected && diffPatch && !editMode ? (
					renderPatchView(diffPatch)
				) : oldContent !== null && textData && !editMode ? (
					renderDiffView(oldContent, textData.content)
				) : loadState.status === "loading" ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
						<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
						<span className="text-xs text-muted-foreground">{t("fileViewer.loading")}</span>
					</div>
				) : loadState.status === "error" ? (
					loadState.error.includes("ENOENT") && diffPatch && !editMode ? (
						renderPatchView(diffPatch)
					) : oldContent !== null && loadState.error.includes("ENOENT") ? (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
								<FileWarning className="size-3.5 shrink-0" />
								{t("fileViewer.deletedDiff")}
							</div>
							{renderDiffView(oldContent, "")}
						</div>
					) : (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
							<FileWarning className="size-6 text-destructive" />
							<p className="text-xs text-destructive">
								{t("fileViewer.loadFailed")}:{" "}
								{loadState.error.includes("ENOENT") ? t("fileViewer.fileMissing") : loadState.error}
							</p>
						</div>
					)
				) : loadState.status === "image" ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<div
							className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
							style={{
								backgroundImage:
									"conic-gradient(color-mix(in oklab, var(--border) 55%, transparent) 25%, transparent 0 50%, color-mix(in oklab, var(--border) 55%, transparent) 0 75%, transparent 0)",
								backgroundSize: "16px 16px",
							}}
						>
							<img
								src={`data:${loadState.mimeType};base64,${loadState.data}`}
								alt={basename}
								className="max-h-full max-w-full object-contain"
							/>
						</div>
						<div className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
							<span className="rounded-sm bg-foreground/10 px-1.5 py-0.5 font-mono uppercase">
								{loadState.mimeType.split("/")[1] ?? loadState.mimeType}
							</span>
							<span>{formatBytes(loadState.sizeBytes)}</span>
						</div>
					</div>
				) : loadState.status === "binary" ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
						<FileWarning className="size-6 text-muted-foreground" />
						<p className="text-xs text-muted-foreground">{t("fileViewer.binaryNotSupported")}</p>
						<Button variant="outline" size="sm" onClick={handleReveal}>
							<FolderOpen className="size-3.5" />
							{t("fileViewer.revealInFinder")}
						</Button>
					</div>
				) : textData && isMarkdown && !editMode ? (
					<div className="flex min-h-0 flex-1">
						{showToc && !tocCollapsed && (
							<FileViewerToc
								headings={tocHeadings}
								previewRef={previewRef}
								onCollapse={() => setTocCollapsed(true)}
								width={tocWidth}
								onWidthChange={setTocWidth}
							/>
						)}
						<div className="flex min-h-0 flex-1 flex-col">
							{showToc && tocCollapsed && <FileViewerTocExpandButton onExpand={() => setTocCollapsed(false)} />}
							<div ref={previewRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center">
											<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
										</div>
									}
								>
									<LookMarkdown content={textData.content} docs />
								</Suspense>
							</div>
						</div>
					</div>
				) : textData && editMode && (isMarkdown || isAttachment) ? (
					<textarea
						className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={handleEditorKeyDown}
						spellCheck={false}
					/>
				) : textData && language && !highlightFailed ? (
					highlightedHtml ? (
						<div className="file-viewer-code min-h-0 flex-1 overflow-auto text-xs">
							{/* biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 高亮输出为本地生成的可信 HTML */}
							<div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
						</div>
					) : (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
							<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
						</div>
					)
				) : textData ? (
					<div className="min-h-0 flex-1 overflow-auto">
						<pre className="m-0 min-h-full whitespace-pre p-4 font-mono text-xs leading-relaxed">
							{textData.content}
						</pre>
					</div>
				) : null}
				{textData && (
					<div className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
						{!textData.inProject && (
							<span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
								{t("fileViewer.readOnly")}
							</span>
						)}
						{language && (
							<span className="rounded-sm bg-foreground/10 px-1.5 py-0.5 font-mono uppercase">{language}</span>
						)}
						<span>{formatBytes(textData.sizeBytes)}</span>
						{textData.truncated && <span className="ml-auto">{t("fileViewer.truncatedNotice")}</span>}
					</div>
				)}
			</div>
			{!windowMode && !dockMode && (
				<div
					className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
					onPointerDown={handleResizeStart}
					aria-hidden="true"
				/>
			)}
		</div>
	);
}
