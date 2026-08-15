// ============================================================
// AppLayout — 主应用布局（Sidebar + 主内容区 + RightPanel + Dialogs）
// ============================================================

import { ErrorBoundarySection } from "@look/ui/components/ErrorBoundary";
import { Button } from "@look/ui/components/ui/button";
import { Separator } from "@look/ui/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { AgentInfo, AttachmentRef, ImageContent, ProjectInfo, ThinkingLevel } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { PanelRightOpen } from "lucide-react";
import { lazy, memo, type ReactNode, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { PANEL_LAYOUT, resolvePanelTracks } from "../lib/panelLayout";
import { syncTrafficLightPosition } from "../lib/trafficLight";
import {
	activeProjectAtom,
	appReadyPhaseAtom,
	type ProviderSettingsData,
	pendingDeleteProjectAtom,
	rightPanelAutoCollapsedAtom,
	rightPanelCollapsedAtom,
	rightPanelEffectiveCollapsedAtom,
	settingsTabAtom,
	showAgentSquareAtom,
	showDraftsAtom,
	showScheduledTasksAtom,
	showSettingsAtom,
	sidebarAutoCollapsedAtom,
	sidebarEffectiveCollapsedAtom,
	windowFullscreenAtom,
} from "../store/atoms";
import { dockedFileAtom, dockPanelWidthAtom, rightPanelWidthAtom } from "../store/projectAtoms";
import ChatPanel from "./chat/ChatPanel";
import EmptySessionState from "./chat/EmptySessionState";
import WelcomeScreen from "./chat/WelcomeScreen";
import DeleteProjectDialog from "./dialogs/DeleteProjectDialog";
import ImagePreviewDialog from "./dialogs/ImagePreviewDialog";
import NewProjectDialog from "./dialogs/NewProjectDialog";
import OAuthLoginDialog from "./dialogs/OAuthLoginDialog";
import PermissionDialog from "./dialogs/PermissionDialog";
import PlanApprovalDialog from "./dialogs/PlanApprovalDialog";
import DraftStickyNote from "./drafts/DraftStickyNote";
import DraftsPage from "./drafts/DraftsPage";
import Sidebar from "./Sidebar";
import ScheduledTasksPage from "./scheduler/ScheduledTasksPage";
import SettingsPage from "./settings/SettingsPage";
import TopSessionBar from "./TopSessionBar";
import { DockFilePanel } from "./workspace/DockFilePanel";
import { RightPanel } from "./workspace/RightPanel";

const AgentSquare = lazy(() => import("./AgentMarketplace/AgentSquare"));

interface AppLayoutProps {
	/** 是否有至少一个会话（只传布尔，避免 agentsAtom 每次写入击穿 memo）。 */
	hasAgents: boolean;
	activeAgent: AgentInfo | null;
	activeAgentId: string | null;
	projects: ProjectInfo[];
	newProjectCwd: string | null;
	setNewProjectCwd: (v: string | null) => void;
	providerSettings: ProviderSettingsData;
	handleSendMessage: (
		text: string,
		images?: ImageContent[],
		attachments?: AttachmentRef[],
		sendMode?: "steer" | "followUp",
	) => Promise<boolean>;
	handleSelectAgent: (agentId: string) => void;
	handleDestroyAgent: (agentId: string) => void;
	handleAbortAgent: () => void;
	handleThinkingChange: (level: ThinkingLevel) => void;
	handleModelChanged: (model: string) => void;
	handleCreateClick: (projectId: string) => Promise<string | null>;
	handleOpenProject: () => void;
	handleSwitchProject: (projectId: string) => Promise<void>;
	handleDeleteProject: (project: ProjectInfo) => void;
	handleProjectCreated: (projectId: string) => void;
	handleDeleteProjectCancelled: () => void;
	handleDeleteProjectConfirmed: () => void;
	handleRenameProject: (projectId: string, name: string) => void;
	handleOpenProjectFolderById: (projectId: string) => void;
	onProvidersChange: (data: ProviderSettingsData) => void;
}

function AppLayout({
	hasAgents,
	activeAgent,
	activeAgentId,
	projects,
	newProjectCwd,
	setNewProjectCwd,
	providerSettings,
	handleSendMessage,
	handleSelectAgent,
	handleDestroyAgent,
	handleAbortAgent,
	handleThinkingChange,
	handleModelChanged,
	handleCreateClick,
	handleOpenProject,
	handleSwitchProject,
	handleDeleteProject,
	handleProjectCreated,
	handleDeleteProjectCancelled,
	handleDeleteProjectConfirmed,
	handleRenameProject,
	handleOpenProjectFolderById,
	onProvidersChange,
}: AppLayoutProps) {
	const { t } = useTranslation();
	const appReadyPhase = useAtomValue(appReadyPhaseAtom);
	// 布局/视图开关等纯 UI 状态直接从原子读取，App.tsx 无需再逐层传递（Props Drilling 收敛）。
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	// 布局与可见性统一读 effective：手动折叠或窄窗口自动折叠都会隐藏右栏。
	const rightPanelCollapsed = useAtomValue(rightPanelEffectiveCollapsedAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const dockedFile = useAtomValue(dockedFileAtom);
	const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
	const dockPanelWidth = useAtomValue(dockPanelWidthAtom);
	const viewportWidth = useViewportWidth();

	// 面板宽度解析统一走 resolvePanelTracks（单一事实源）：保证 main >= 340 且绝不横向溢出
	const layout = resolvePanelTracks({
		viewportWidth,
		sidebarCollapsed,
		rightPanelCollapsed,
		rightPanelWidth,
		dockOpen: !!dockedFile,
		dockPanelWidth,
	});
	const showAgentSquare = useAtomValue(showAgentSquareAtom);
	const showDrafts = useAtomValue(showDraftsAtom);
	const showScheduledTasks = useAtomValue(showScheduledTasksAtom);
	const pendingDelete = useAtomValue(pendingDeleteProjectAtom);
	const showSettings = useAtomValue(showSettingsAtom);
	const settingsTab = useAtomValue(settingsTabAtom);
	const setSidebarAutoCollapsed = useSetAtom(sidebarAutoCollapsedAtom);
	const setRightPanelCollapsed = useSetAtom(rightPanelCollapsedAtom);
	const setRightPanelAutoCollapsed = useSetAtom(rightPanelAutoCollapsedAtom);
	const windowFullscreen = useAtomValue(windowFullscreenAtom);

	// 首帧渲染后标记 data-app-ready，CSS 可据此禁用初始加载过渡
	useEffect(() => {
		const el = document.documentElement;
		el.setAttribute("data-app-ready", "false");
		const raf = requestAnimationFrame(() => {
			el.setAttribute("data-app-ready", "true");
		});
		return () => cancelAnimationFrame(raf);
	}, []);

	// 平台与全屏状态同步到 <html> dataset：mac-titlebar-pad 等 CSS 据此
	// 在 macOS 非全屏时为红绿灯按钮留白（全屏时红绿灯隐藏，留白收回）。
	useEffect(() => {
		const el = document.documentElement;
		el.dataset.platform = window.look?.platform ?? "";
		el.dataset.fullscreen = String(windowFullscreen);
	}, [windowFullscreen]);

	// macOS 红绿灯垂直对齐：实测当前顶部栏中心回传主进程（lib/trafficLight）。
	// 侧栏折叠、页面切换（Agent 广场/定时任务）会替换当前顶部栏，需重新实测。
	// 侧栏折叠/展开有 260ms 平移动画（App.css），期间测到的是中间态，
	// 故 rAF 首测后再于动画结束(300ms)复测一次，两次均为幂等校正。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 视图切换（侧栏折叠/广场/定时任务/全屏）是重新实测的触发信号，回调内不直接引用这些值
	useEffect(() => {
		const raf = requestAnimationFrame(() => syncTrafficLightPosition());
		const settle = setTimeout(() => syncTrafficLightPosition(), 300);
		window.addEventListener("resize", syncTrafficLightPosition);
		return () => {
			cancelAnimationFrame(raf);
			clearTimeout(settle);
			window.removeEventListener("resize", syncTrafficLightPosition);
		};
	}, [sidebarCollapsed, showAgentSquare, showScheduledTasks, showDrafts, showSettings, windowFullscreen]);

	// 窄窗口自动折叠侧边栏：优先折叠右栏，再折叠左栏。
	// 只操作 auto 态（rightPanelAutoCollapsedAtom / sidebarAutoCollapsedAtom）：
	// 手动折叠与持久化偏好（rightPanelCollapsedAtom）不被 resize 覆盖
	// （2026-08 修复：此前 >=1100px 的任意 resize/启动帧都会把手动折叠强制展开）。
	useEffect(() => {
		function onResize() {
			const width = window.innerWidth;
			if (width < 1050) setRightPanelAutoCollapsed(true);
			if (width < 950) setSidebarAutoCollapsed(true);
			if (width >= 1100) {
				setRightPanelAutoCollapsed(false);
				setSidebarAutoCollapsed(false);
			}
		}
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [setRightPanelAutoCollapsed, setSidebarAutoCollapsed]);

	// 主内容区视图枚举：新增视图只需加一个 case + 分支条件，避免在 JSX 里
	// 叠嵌套三元（此前是 4 层三元，任何新增视图都要改整串条件）。
	type MainView = "loading" | "scheduled" | "drafts" | "welcome" | "agent-square" | "chat";
	const mainView: MainView =
		appReadyPhase < 1
			? "loading"
			: showDrafts
				? "drafts"
				: showScheduledTasks
					? "scheduled"
					: projects.length === 0
						? "welcome"
						: showAgentSquare
							? "agent-square"
							: "chat";

	const renderMainView = (): ReactNode => {
		switch (mainView) {
			case "loading":
				return null;
			case "scheduled":
				return <ScheduledTasksPage />;
			case "drafts":
				return (
					<DraftsPage
						projects={projects}
						handleCreateClick={handleCreateClick}
						handleSendMessage={handleSendMessage}
					/>
				);
			case "welcome":
				return <WelcomeScreen onOpenProject={handleOpenProject} />;
			case "agent-square":
				return (
					<Suspense
						fallback={
							<div
								className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
								role="status"
							>
								{t("common.loading")}
							</div>
						}
					>
						<AgentSquare />
					</Suspense>
				);
			case "chat":
				return (
					<>
						<TopSessionBar activeAgent={activeAgent} />
						{activeAgent ? (
							<ChatPanel
								key={activeAgent.id}
								agentId={activeAgent.id}
								agentName={activeAgent.name}
								currentModel={activeAgent.model}
								currentThinking={activeAgent.thinkingLevel}
								onSend={handleSendMessage}
								onThinkingChange={handleThinkingChange}
								onModelChange={handleModelChanged}
								onAbort={handleAbortAgent}
							/>
						) : hasAgents ? (
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
								选择左侧会话查看消息
							</div>
						) : appReadyPhase >= 2 ? (
							<EmptySessionState handleCreateClick={handleCreateClick} />
						) : null}
					</>
				);
		}
	};

	return (
		<div
			className="app-shell h-screen overflow-hidden bg-background"
			data-sidebar-collapsed={sidebarCollapsed}
			data-right-panel-collapsed={rightPanelCollapsed}
			data-dock-open={!!dockedFile}
			style={
				{
					// 面板宽度由 resolvePanelTracks 统一解析：拖拽把手改 atom，显示时钳制到可用空间；折叠/收起时归 0
					"--sidebar-width": `${PANEL_LAYOUT.SIDEBAR_WIDTH}px`,
					"--right-panel-track": `${layout.rightTrack}px`,
					"--dock-track": `${layout.dockTrack}px`,
				} as React.CSSProperties
			}
		>
			<ErrorBoundarySection>
				<Sidebar
					onSelect={handleSelectAgent}
					onDestroy={handleDestroyAgent}
					onCreateClick={handleCreateClick}
					onCreateProject={handleOpenProject}
					onSelectProject={handleSwitchProject}
					onDeleteProject={handleDeleteProject}
					onOpenProject={handleOpenProjectFolderById}
					onRenameProject={handleRenameProject}
				/>
			</ErrorBoundarySection>

			<Separator orientation="vertical" className="sidebar-separator bg-transparent" />

			<main className="flex min-w-[340px] flex-col overflow-hidden bg-background">
				<ErrorBoundarySection>{renderMainView()}</ErrorBoundarySection>
			</main>

			<RightPanel />

			{/* 文件查看器 Dock 面板：位于右侧面板右侧，grid 第 5 列 --dock-track 控制滑入/出 */}
			<DockFilePanel />

			{/* 非聊天视图（草稿/定时任务/广场）的右栏展开入口：这些视图进入时会把右栏
			    折叠且不渲染 TopSessionBar（其展开按钮只在 chat 视图可见），折叠态下右栏
			    自身按钮随面板整体隐藏，这里提供贴右缘的悬浮展开按钮兜底（2026-08 修复）。 */}
			{mainView !== "chat" && rightPanelCollapsed && activeProject && !dockedFile && (
				<div className="fixed right-0 top-1/2 z-30 -translate-y-1/2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon-sm"
								variant="ghost"
								className="app-no-drag h-16 w-5 rounded-l-md border border-r-0 border-hairline"
								onClick={() => {
									setRightPanelCollapsed(false);
									setRightPanelAutoCollapsed(false);
								}}
								aria-label={t("rightPanel.expand")}
							>
								<PanelRightOpen className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">{t("rightPanel.expand")}</TooltipContent>
					</Tooltip>
				</div>
			)}

			{/* 悬浮便利贴：任何视图可见，不替换主内容区 */}
			<DraftStickyNote />

			{newProjectCwd && (
				<NewProjectDialog
					open={!!newProjectCwd}
					cwd={newProjectCwd}
					onClose={() => setNewProjectCwd(null)}
					onCreated={handleProjectCreated}
				/>
			)}
			{pendingDelete && (
				<DeleteProjectDialog
					open={!!pendingDelete}
					projectId={pendingDelete.projectId}
					projectName={pendingDelete.projectName}
					agentCount={pendingDelete.agentCount}
					runningCount={pendingDelete.runningCount}
					onClose={handleDeleteProjectCancelled}
					onDeleted={handleDeleteProjectConfirmed}
				/>
			)}
			<OAuthLoginDialog />
			<PermissionDialog />
			<ImagePreviewDialog />
			<PlanApprovalDialog key={`plan-approval:${activeAgentId ?? "none"}`} sessionId={activeAgentId} />

			{/* 设置页：全屏覆盖层，遮住左侧栏与右侧面板；z-40 低于 Radix Dialog 的 z-50，保证设置页内子弹窗正常显示 */}
			{showSettings && (
				<div className="fixed inset-0 z-40 bg-background">
					<SettingsPage
						providers={providerSettings.providers}
						customProviders={providerSettings.customProviders}
						customStats={providerSettings.customStats}
						onProvidersChange={onProvidersChange}
						defaultTab={settingsTab}
					/>
				</div>
			)}
		</div>
	);
}

// memo 包裹：App.tsx 订阅了大量 atom（如 showSettingsAtom）,任何 atom
// 变化都会让 App 重新执行。用 memo 让 props 没变化的常见状态更新（如
// showAgentSquare / settingsTab 等被切换时）跳过整棵子树重渲染。
// 关键依赖上游的父组件已经稳定所有回调与对象引用(useMemo/useCallback)。
export default memo(AppLayout);
