// ============================================================
// Sidebar — 主编排组件（Header + ProjectTree + Footer）
// 外层只读 collapsed 用于 CSS 动画；内层 memo 避免过渡期重渲染
// ============================================================

import { UserAvatar } from "@look/ui/components/UserAvatar";
import { Button } from "@look/ui/components/ui/button";
import { ScrollArea } from "@look/ui/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { useAtomValue, useSetAtom } from "jotai";
import { Bot, Clock3, FolderOpen, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { memo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { appStore } from "../../store/appStore";
import {
	activeProjectAtom,
	rightPanelCollapsedAtom,
	settingsTabAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
	showSettingsAtom,
	sidebarAutoCollapsedAtom,
	sidebarCollapsedAtom,
	sidebarEffectiveCollapsedAtom,
} from "../../store/atoms";
import { userProfileAtom } from "../../store/authAtoms";
import ProjectTree from "./ProjectTree";
import TopUpdateButton from "./TopUpdateButton";
import type { SidebarProps } from "./types";

const SidebarInner = memo(function SidebarInner({
	onSelect,
	onDestroy,
	onCreateClick,
	onCreateProject,
	onSelectProject,
	onDeleteProject,
	onOpenProject,
	onRenameProject,
}: SidebarProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);
	const showAgentSquare = useAtomValue(showAgentSquareAtom);
	const showScheduledTasks = useAtomValue(showScheduledTasksAtom);
	const showSettings = useAtomValue(showSettingsAtom);
	const setSettingsTab = useSetAtom(settingsTabAtom);

	return (
		<>
			<header
				className="sidebar-titlebar app-drag mac-titlebar-pad h-12 shrink-0 border-b border-hairline"
				aria-label={t("sidebar.navigation", "Sidebar navigation")}
			>
				<span className="sr-only">{t("sidebar.navigation", "Sidebar navigation")}</span>
			</header>

			<ScrollArea
				className="sidebar-scroll-area min-h-0 flex-1"
				type="always"
				aria-label={t("sidebar.projectsLabel", "Projects and sessions")}
			>
				<div className="space-y-1.5 px-2 py-2">
					<ProjectTree
						onSelect={onSelect}
						onDestroy={onDestroy}
						onCreateClick={onCreateClick}
						onCreateProject={onCreateProject}
						onSelectProject={onSelectProject}
						onDeleteProject={onDeleteProject}
						onOpenProject={onOpenProject}
						onRenameProject={onRenameProject}
					/>
				</div>
			</ScrollArea>

			<nav
				className="sidebar-footer shrink-0 border-t border-hairline"
				aria-label={t("sidebar.secondaryNavigation", "More views")}
			>
				<button
					type="button"
					onClick={() => {
						appStore.set(showScheduledTasksAtom, true);
						appStore.set(showAgentSquareAtom, false);
						appStore.set(showSettingsAtom, false);
						appStore.set(rightPanelCollapsedAtom, true);
					}}
					className={`sidebar-footer-item group flex h-10 w-full shrink-0 items-center gap-2.5 px-3 text-left transition-colors ${showScheduledTasks ? "bg-foreground/[0.075] text-foreground" : "hover:bg-foreground/[0.06]"}`}
					title={t("scheduledTasks.title")}
					aria-current={showScheduledTasks ? "page" : undefined}
				>
					<span
						className={`inline-flex size-5 items-center justify-center rounded-[5px] transition-colors ${showScheduledTasks ? "bg-foreground/[0.12]" : "bg-foreground/[0.06] group-hover:bg-foreground/[0.12]"}`}
					>
						<Clock3
							className={`size-3 transition-colors ${showScheduledTasks ? "text-foreground/80" : "text-foreground/40 group-hover:text-foreground/60"}`}
						/>
					</span>
					<span
						className={`text-[12px] font-medium ${showScheduledTasks ? "text-foreground" : "text-muted-foreground"}`}
					>
						{t("scheduledTasks.title")}
					</span>
				</button>

				<button
					type="button"
					onClick={() => {
						appStore.set(showAgentSquareAtom, true);
						appStore.set(showScheduledTasksAtom, false);
						appStore.set(showSettingsAtom, false);
						appStore.set(rightPanelCollapsedAtom, true);
					}}
					className={`sidebar-footer-item group flex h-10 w-full shrink-0 items-center gap-2.5 px-3 text-left transition-colors ${showAgentSquare ? "bg-foreground/[0.075] text-foreground" : "hover:bg-foreground/[0.06]"}`}
					title={t("marketplace.title")}
					aria-current={showAgentSquare ? "page" : undefined}
				>
					<span
						className={`inline-flex size-5 items-center justify-center rounded-[5px] transition-colors ${showAgentSquare ? "bg-foreground/[0.12]" : "bg-foreground/[0.06] group-hover:bg-foreground/[0.12]"}`}
					>
						<Bot
							className={`size-3 transition-colors ${showAgentSquare ? "text-foreground/80" : "text-foreground/35 group-hover:text-foreground/55"}`}
						/>
					</span>
					<span
						className={`text-[12px] font-medium ${showAgentSquare ? "text-foreground" : "text-muted-foreground"}`}
					>
						{t("marketplace.title")}
					</span>
				</button>

				<button
					type="button"
					onClick={() => {
						setSettingsTab("profile");
						appStore.set(showSettingsAtom, true);
						appStore.set(showAgentSquareAtom, false);
						appStore.set(showScheduledTasksAtom, false);
					}}
					className={`sidebar-footer-item group flex h-10 w-full shrink-0 items-center gap-2 px-3 text-left transition-colors ${showSettings ? "bg-foreground/[0.075] text-foreground" : "hover:bg-foreground/[0.065]"}`}
					aria-current={showSettings ? "page" : undefined}
					title={t("sidebar.settings", "Settings")}
				>
					<UserAvatar avatar={userProfile.avatar} size="sm" />
					<span
						className={`min-w-0 flex-1 truncate text-[12px] font-medium ${showSettings ? "text-foreground" : "text-muted-foreground"}`}
					>
						{userProfile.userName || t("agent.you", "You")}
					</span>
					<span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/45">
						{t("sidebar.settings", "Settings")}
					</span>
				</button>
			</nav>
		</>
	);
});

export default function Sidebar(props: SidebarProps) {
	const collapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const { t } = useTranslation();
	const canCreateSession = activeProject?.valid ?? false;
	// 设置页为全屏遮罩（z-40）盖住侧边栏；按钮组 portal 到 body 层 z-50，
	// 不隐藏会浮在设置页顶部，故设置页打开时卸载。
	const showSettings = useAtomValue(showSettingsAtom);

	// 按钮组通过 portal 渲染到 body 层并 fixed 定位，脱离 sidebar-wrapper 的 transform，
	// 折叠/展开时完全不跟随面板移动；折叠时折叠按钮变展开按钮，其余按钮保持显示。
	const headerActions = (
		<div
			className="sidebar-header-actions"
			data-collapsed={collapsed || undefined}
			role="toolbar"
			aria-label={t("sidebar.actions", "Sidebar actions")}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="line-ghost"
						size="icon"
						onClick={() => {
							if (collapsed) {
								appStore.set(sidebarAutoCollapsedAtom, false);
								appStore.set(sidebarCollapsedAtom, false);
							} else {
								appStore.set(sidebarCollapsedAtom, true);
							}
						}}
						aria-label={
							collapsed ? t("sidebar.expand", "Expand sidebar") : t("sidebar.collapse", "Collapse sidebar")
						}
					>
						{collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{collapsed ? t("sidebar.expand", "Expand sidebar") : t("sidebar.collapse", "Collapse sidebar")}
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="line-ghost"
						size="icon"
						className="relative"
						onClick={props.onCreateProject}
						aria-label={t("project.openProject", "Add project folder")}
					>
						<FolderOpen className="size-4" />
						<Plus className="absolute ml-3 mt-3 size-2.5 rounded-full bg-sidebar" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("project.openProject", "Add project folder")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				{/* disabled 按钮不派发 pointer 事件，span 包裹保证悬停提示仍可触发 */}
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<Button
							variant="line-ghost"
							size="icon"
							onClick={() => {
								if (activeProject) props.onCreateClick(activeProject.id);
							}}
							disabled={!canCreateSession}
							aria-label={t("sidebar.newSession", "New session")}
						>
							<MessageSquarePlus className="size-4" />
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{canCreateSession
						? t("sidebar.newSession", "New session")
						: t("workspace.noActiveProject", "Open a project first")}
				</TooltipContent>
			</Tooltip>

			{/* 顶部最右侧：更新胶囊（available/downloading 自动下载进度，downloaded 手动重启） */}
			<TopUpdateButton />
		</div>
	);

	return (
		<>
			<aside
				className="workspace-ledger glass-panel sidebar-wrapper flex h-full shrink-0 flex-col overflow-hidden rounded-l-xl border border-t-0"
				data-collapsed={collapsed}
			>
				<SidebarInner {...props} />
			</aside>
			{!showSettings && createPortal(headerActions, document.body)}
		</>
	);
}
