// ============================================================
// RightPanel — 右侧边栏容器(工作区 / 变更 双 tab)
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { FolderTree, GitCommitHorizontal, PanelRightClose } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
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
	sidebarEffectiveCollapsedAtom,
} from "../../store/atoms";
import { browserPanelOpenAtom } from "../../store/browserAtoms";
import ChangesPanel from "./ChangesPanel";
import { PanelResizeHandle } from "./PanelResizeHandle";
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

	const rightPanelTabs = [
		{ id: "workspace" as const, icon: FolderTree, label: t("rightPanel.workspace"), count: 0 },
		{ id: "changes" as const, icon: GitCommitHorizontal, label: t("rightPanel.changes"), count: dirtyCount },
	];

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
			<header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
				<div role="tablist" className="flex flex-1 self-stretch" aria-label={t("rightPanel.tabsLabel")}>
					{rightPanelTabs.map(({ id, icon: Icon, label, count }) => {
						const active = tab === id;
						return (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={active}
								className={`relative flex items-center gap-1.5 px-2.5 text-[11px] font-medium transition-colors ${
									active ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"
								}`}
								onClick={() => setTab(id)}
							>
								<Icon className="size-3.5 shrink-0" aria-hidden />
								{label}
								{count > 0 && (
									<span className="ml-0.5 font-mono text-[10px] text-[var(--status-warning)]">{count}</span>
								)}
								{active && <span className="absolute inset-x-2 -bottom-px h-px bg-foreground" aria-hidden />}
							</button>
						);
					})}
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon-sm"
							variant="ghost"
							className="shrink-0 rounded-md"
							onClick={() => setCollapsed(true)}
							aria-label={t("rightPanel.collapse")}
						>
							<PanelRightClose className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("rightPanel.collapse")}</TooltipContent>
				</Tooltip>
			</header>
			<div key={tab} className="animate-draw-in flex min-h-0 flex-1 flex-col">
				{tab === "workspace" && activeProject && (
					<WorkspaceTreePanel projectId={activeProject.id} cwd={activeProject.cwd} />
				)}
				{tab === "changes" && activeProject && (
					<ChangesPanel projectId={activeProject.id} cwd={activeProject.cwd} />
				)}
			</div>
		</aside>
	);
}
