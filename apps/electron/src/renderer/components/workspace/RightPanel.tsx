// ============================================================
// RightPanel — 右侧边栏容器(v0.6:共享区 + 工作区 双 tab)
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { PanelRightClose } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { linkedDockTrack, PANEL_LAYOUT, resolvePanelTracks } from "../../lib/panelLayout";
import { appStore } from "../../store/appStore";
import {
	activeProjectAtom,
	dockedFileAtom,
	dockPanelWidthAtom,
	projectGitInfoAtomFamily,
	rightPanelCollapsedAtom,
	rightPanelEffectiveCollapsedAtom,
	rightPanelTabAtom,
	rightPanelWidthAtom,
	sharedFilesAtomFamily,
	sharedFilesErrorAtomFamily,
	sharedFilesLoadingAtomFamily,
	sidebarEffectiveCollapsedAtom,
} from "../../store/atoms";
import { browserPanelOpenAtom } from "../../store/browserAtoms";
import ChangesPanel from "./ChangesPanel";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { SharedAreaPanel } from "./SharedAreaPanel";
import { WorkspaceTreePanel } from "./WorkspaceTreePanel";

// 没有 active project 时使用的占位 projectId,避免 hook 调用顺序不稳定
const PLACEHOLDER_PROJECT_ID = "__right_panel_placeholder__";

export function RightPanel() {
	const { t } = useTranslation();
	const activeProject = useAtomValue(activeProjectAtom);
	// 读 effective：手动折叠或窄窗口自动折叠都按折叠处理（与 AppLayout 布局口径一致）。
	const collapsed = useAtomValue(rightPanelEffectiveCollapsedAtom);
	const [tab, setTab] = useAtom(rightPanelTabAtom);
	const setCollapsed = useSetAtom(rightPanelCollapsedAtom);
	const [rightPanelWidth, setRightPanelWidth] = useAtom(rightPanelWidthAtom);
	const dockedFile = useAtomValue(dockedFileAtom);
	const browserOpen = useAtomValue(browserPanelOpenAtom);
	const dockPanelWidth = useAtomValue(dockPanelWidthAtom);
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const viewportWidth = useViewportWidth();
	const projectId = activeProject?.id ?? PLACEHOLDER_PROJECT_ID;
	// Dock 打开 = 文件查看或内置浏览器任一打开（共用右侧 Dock 容器）。
	const dockOpen = !!dockedFile || browserOpen;
	const gitInfo = useAtomValue(projectGitInfoAtomFamily(projectId));
	const dirtyCount = gitInfo?.dirtyCount ?? 0;

	// 始终调用 hooks;在 effect 内判断 projectId 是否有效
	const filesAtom = sharedFilesAtomFamily(projectId);
	const loadingAtom = sharedFilesLoadingAtomFamily(projectId);
	const errorAtom = sharedFilesErrorAtomFamily(projectId);
	const sharedFiles = useAtomValue(filesAtom);
	const isLoading = useAtomValue(loadingAtom);
	const sharedFilesError = useAtomValue(errorAtom);
	const setIsLoading = useSetAtom(loadingAtom);

	const refreshSharedFiles = useCallback(
		async (pid: string, cancelled: { current: boolean }, opts?: { silent?: boolean }) => {
			setIsLoading(true);
			try {
				const result = await window.look.listSharedFiles(pid);
				if (cancelled.current) return;
				if (result?.success) {
					appStore.set(sharedFilesAtomFamily(pid), result.nodes ?? []);
					appStore.set(sharedFilesErrorAtomFamily(pid), null);
				} else {
					const message = result?.error ?? t("rightPanel.loadFailed");
					appStore.set(sharedFilesErrorAtomFamily(pid), message);
					// silent:调用方(如 onAfterChange 的 throw→操作 handler)自己负责 toast,避免同一条错误弹两遍。
					if (!opts?.silent) toast.error(message);
				}
			} catch (error: unknown) {
				if (cancelled.current) return;
				const message = error instanceof Error ? error.message : t("rightPanel.loadFailed");
				appStore.set(sharedFilesErrorAtomFamily(pid), message);
				if (!opts?.silent) toast.error(message);
			} finally {
				if (!cancelled.current) setIsLoading(false);
			}
		},
		[setIsLoading, t],
	);

	// 切换项目时拉取新文件树（占位 projectId 时跳过）。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const cancelled = { current: false };
		void refreshSharedFiles(projectId, cancelled);
		return () => {
			cancelled.current = true;
		};
	}, [projectId, refreshSharedFiles]);

	// 切换到共享区 tab 时主动刷新：watcher 实时推送在部分环境下可能
	// 未触发（chokidar 跨进程/跨卷限制），切 tab 时补偿拉取保证数据新鲜。
	useEffect(() => {
		if (tab !== "shared" || projectId === PLACEHOLDER_PROJECT_ID) return;
		const cancelled = { current: false };
		void refreshSharedFiles(projectId, cancelled);
		return () => {
			cancelled.current = true;
		};
	}, [tab, projectId, refreshSharedFiles]);

	// 启动共享区 watcher。切项目时显式 stop 旧 watcher 避免资源泄漏；
	// 主进程 startWatching 幂等，重新进入同一项目无副作用。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const pid = projectId;
		window.look
			.startSharedWatch(pid)
			.then((result) => {
				if (!result?.success) toast.error(result?.error ?? t("rightPanel.watchFailed"));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : t("rightPanel.watchFailed");
				toast.error(message);
			});
		return () => {
			window.look.stopSharedWatch(pid).catch(() => {});
		};
	}, [projectId, t]);

	// 「变更」tab 徽标的脏文件计数数据：不依赖 GitStatusBar 是否挂载（无会话、
	// 草稿/广场等非聊天视图下 GitStatusBar 不存在，徽标会缺失），右栏自行拉取一次；
	// 之后由主进程 HEAD watcher 推送（project:git-info）保持新鲜。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		let cancelled = false;
		window.look
			.getProjectGitInfo(projectId)
			.then((result) => {
				if (cancelled || !result?.success) return;
				appStore.set(projectGitInfoAtomFamily(projectId), result.info);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	if (!activeProject) return null;

	// 面板宽度解析统一走 resolvePanelTracks（单一事实源）
	const layout = resolvePanelTracks({
		viewportWidth,
		sidebarCollapsed,
		rightPanelCollapsed: collapsed,
		rightPanelWidth,
		dockOpen,
		dockPanelWidth,
	});
	// 显示宽度被空间压缩时不再隐藏把手：把手始终可拖，拖动会更新存储宽度，
	// resolvePanelTracks 下一帧重新分配空间；min/max 已按对方面板下限收紧，
	// 拖到上限会自然让位，不会“撞墙回弹”。
	// 拖拽期间通过 linked 同步改写 Dock track：main 触底（340）后 Dock 才让位，
	// 与松手后 resolve 的 dock 口径完全一致（linkedDockTrack 镜像同一公式）。

	return (
		<aside
			className={cn(
				"right-panel-wrapper relative flex h-full shrink-0 flex-col overflow-hidden bg-background",
				// Dock 打开时右栏右侧与 Dock 相接：右侧直角 + 去掉右边框（Dock 自带 border-l 作单线分隔），
				// 左缘保留卡片圆角；Dock 关闭时恢复全圆角全边框
				dockOpen ? "rounded-l-xl border-y border-l" : "rounded-xl border",
			)}
			data-collapsed={collapsed}
			aria-label={t("rightPanel.label")}
			inert={collapsed || layout.rightTrack === 0 || undefined}
		>
			{/* 拖拽调宽把手：面板左侧边缘，折叠时不渲染（折叠时 track=0 也不渲染） */}
			{!collapsed && layout.rightTrack > 0 && (
				<PanelResizeHandle
					cssVar="--right-panel-track"
					width={layout.rightTrack}
					min={PANEL_LAYOUT.RIGHT_MIN}
					max={layout.rightMax}
					linked={
						dockOpen
							? {
									cssVar: "--dock-track",
									map: (right) => linkedDockTrack(layout, right, dockPanelWidth, true),
								}
							: undefined
					}
					onCommit={setRightPanelWidth}
					ariaLabel={t("rightPanel.resize")}
				/>
			)}
			<header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
				<div role="tablist" className="flex flex-1 gap-1" aria-label={t("rightPanel.tabsLabel")}>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "workspace"}
						className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							tab === "workspace"
								? "bg-foreground/10 text-foreground"
								: "text-muted-foreground hover:bg-foreground/5"
						}`}
						onClick={() => setTab("workspace")}
					>
						{t("rightPanel.workspace")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "shared"}
						className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							tab === "shared"
								? "bg-foreground/10 text-foreground"
								: "text-muted-foreground hover:bg-foreground/5"
						}`}
						onClick={() => setTab("shared")}
					>
						{t("rightPanel.shared")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "changes"}
						className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							tab === "changes"
								? "bg-foreground/10 text-foreground"
								: "text-muted-foreground hover:bg-foreground/5"
						}`}
						onClick={() => setTab("changes")}
					>
						{t("rightPanel.changes")}
						{dirtyCount > 0 && (
							<span className="ml-1 rounded bg-amber-500/15 px-1 font-mono text-[9px] text-amber-500">
								{dirtyCount}
							</span>
						)}
					</button>
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon-sm"
							variant="ghost"
							className="shrink-0 rounded-md border border-hairline"
							onClick={() => setCollapsed(true)}
							aria-label={t("rightPanel.collapse")}
						>
							<PanelRightClose className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("rightPanel.collapse")}</TooltipContent>
				</Tooltip>
			</header>
			{tab === "workspace" && activeProject && (
				<WorkspaceTreePanel projectId={activeProject.id} cwd={activeProject.cwd} />
			)}
			{tab === "shared" && activeProject && (
				<SharedAreaPanel
					projectId={activeProject.id}
					files={sharedFiles}
					isLoading={isLoading}
					error={sharedFilesError}
					onAfterChange={async () => {
						const cancelled = { current: false };
						await refreshSharedFiles(activeProject!.id, cancelled, { silent: true });
						// 失败时向上抛出让操作方（创建/删除/导入等）收到错误并 toast（silent 已抑制本函数自身的 toast）。
						if (appStore.get(sharedFilesErrorAtomFamily(activeProject!.id))) {
							throw new Error(
								appStore.get(sharedFilesErrorAtomFamily(activeProject!.id)) ?? t("rightPanel.loadFailed"),
							);
						}
					}}
				/>
			)}
			{tab === "changes" && activeProject && <ChangesPanel projectId={activeProject.id} cwd={activeProject.cwd} />}
		</aside>
	);
}
