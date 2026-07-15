// ============================================================
// AppLayout — 主应用布局（Sidebar + 主内容区 + RightPanel + Dialogs）
// ============================================================

import { Separator } from "@shared/components/ui/separator";
import type { AgentInfo, ImageContent, ProjectInfo, ThinkingLevel } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { lazy, memo, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
	appReadyPhaseAtom,
	type ProviderSettingsData,
	rightPanelCollapsedAtom,
	type SettingsTab,
	sidebarCollapsedAtom,
} from "../store/atoms";
import type { RendererSessionPhase, RendererSessionState } from "../store/sessionTypes";
import ChatPanel from "./chat/ChatPanel";
import EmptySessionState from "./chat/EmptySessionState";
import WelcomeScreen from "./chat/WelcomeScreen";
import DeleteProjectDialog from "./dialogs/DeleteProjectDialog";
import NewProjectDialog from "./dialogs/NewProjectDialog";
import PermissionDialog from "./dialogs/PermissionDialog";
import PlanApprovalDialog from "./dialogs/PlanApprovalDialog";
import PlanQuestionDialog from "./dialogs/PlanQuestionDialog";
import UpdateNotification from "./dialogs/UpdateNotification";
import SessionSheetBar from "./SessionSheetBar";
import Sidebar from "./Sidebar";
import ScheduledTasksPage from "./scheduler/ScheduledTasksPage";
import SettingsDialog from "./settings/SettingsDialog";
import { RightPanel } from "./workspace/RightPanel";

const AgentSquare = lazy(() => import("./AgentMarketplace/AgentSquare"));

interface AppLayoutProps {
	sidebarCollapsed: boolean;
	rightPanelCollapsed: boolean;
	agents: AgentInfo[];
	openedSessionIds: string[];
	activeAgent: AgentInfo | null;
	activeAgentId: string | null;
	activeSessionState: RendererSessionState;
	activeQueue: { steering: string[]; followUp: string[] };
	activePhase: RendererSessionPhase;
	autoCollapse: boolean;
	thinkingLevels: ThinkingLevel[];
	projects: ProjectInfo[];
	activeProject: ProjectInfo | null;
	showAgentSquare: boolean;
	showScheduledTasks: boolean;
	newProjectCwd: string | null;
	setNewProjectCwd: (v: string | null) => void;
	pendingDelete: { projectId: string; projectName: string; agentCount: number; runningCount: number } | null;
	showSettings: boolean;
	settingsTab?: SettingsTab;
	providerSettings: ProviderSettingsData;
	handleSendMessage: (text: string, images?: ImageContent[]) => Promise<boolean>;
	handleSelectAgent: (agentId: string) => void;
	handleCloseSessionSheet: (agentId: string) => void;
	handleReorderSessionSheets: (nextIds: string[]) => void;
	handleDestroyAgent: (agentId: string) => void;
	handleAbortAgent: () => void;
	handleDequeueAll: () => void;
	handleThinkingChange: (level: string) => void;
	handleModelChanged: (model: string) => void;
	handleCreateClick: (projectId: string) => void;
	handleRequestApiKeys: () => void;
	handleOpenProject: () => void;
	handleDeleteProject: (project: ProjectInfo) => void;
	handleProjectCreated: (projectId: string) => void;
	handleDeleteProjectCancelled: () => void;
	handleDeleteProjectConfirmed: () => void;
	handleRenameProject: (projectId: string, name: string) => void;
	handleOpenProjectFolderById: (projectId: string) => void;
	handleSettingsClick: () => void;
	handleCloseSettings: () => void;
	handleExpandSidebar: () => void;
	handleExpandRightPanel: () => void;
	onProvidersChange: (data: ProviderSettingsData) => void;
}

function AppLayout({
	sidebarCollapsed,
	rightPanelCollapsed,
	agents,
	openedSessionIds,
	activeAgent,
	activeAgentId,
	activeSessionState,
	activeQueue,
	activePhase,
	autoCollapse,
	thinkingLevels,
	projects,
	activeProject,
	showAgentSquare,
	showScheduledTasks,
	newProjectCwd,
	setNewProjectCwd,
	pendingDelete,
	showSettings,
	settingsTab,
	providerSettings,
	handleSendMessage,
	handleSelectAgent,
	handleCloseSessionSheet,
	handleReorderSessionSheets,
	handleDestroyAgent,
	handleAbortAgent,
	handleDequeueAll,
	handleThinkingChange,
	handleModelChanged,
	handleCreateClick,
	handleRequestApiKeys,
	handleOpenProject,
	handleDeleteProject,
	handleProjectCreated,
	handleDeleteProjectCancelled,
	handleDeleteProjectConfirmed,
	handleRenameProject,
	handleOpenProjectFolderById,
	handleSettingsClick,
	handleCloseSettings,
	handleExpandSidebar,
	handleExpandRightPanel,
	onProvidersChange,
}: AppLayoutProps) {
	const { t } = useTranslation();
	const appReadyPhase = useAtomValue(appReadyPhaseAtom);
	const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
	const setRightPanelCollapsed = useSetAtom(rightPanelCollapsedAtom);

	// 首帧渲染后标记 data-app-ready，CSS 可据此禁用初始加载过渡
	useEffect(() => {
		const el = document.documentElement;
		el.setAttribute("data-app-ready", "false");
		const raf = requestAnimationFrame(() => {
			el.setAttribute("data-app-ready", "true");
		});
		return () => cancelAnimationFrame(raf);
	}, []);

	// 窄窗口自动折叠侧边栏：优先折叠右栏，再折叠左栏
	useEffect(() => {
		function onResize() {
			const width = window.innerWidth;
			if (width < 1050) setRightPanelCollapsed(true);
			if (width < 950) setSidebarCollapsed(true);
			if (width >= 1100) {
				setRightPanelCollapsed(false);
				setSidebarCollapsed(false);
			}
		}
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [setRightPanelCollapsed, setSidebarCollapsed]);

	return (
		<>
			<div
				className="app-shell flex h-screen overflow-hidden bg-background"
				data-sidebar-collapsed={sidebarCollapsed}
				data-right-panel-collapsed={rightPanelCollapsed}
			>
				<Sidebar
					onSelect={handleSelectAgent}
					onDestroy={handleDestroyAgent}
					onCreateClick={handleCreateClick}
					onSettingsClick={handleSettingsClick}
					onCreateProject={handleOpenProject}
					onDeleteProject={handleDeleteProject}
					onOpenProject={handleOpenProjectFolderById}
					onRenameProject={handleRenameProject}
				/>

				<Separator orientation="vertical" className="sidebar-separator bg-transparent" />

				<main className="flex min-w-[340px] flex-1 flex-col overflow-hidden bg-background">
					{appReadyPhase < 1 ? null : showScheduledTasks ? (
						<ScheduledTasksPage />
					) : projects.length === 0 ? (
						<WelcomeScreen onOpenProject={handleOpenProject} />
					) : showAgentSquare ? (
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
					) : (
						<>
							<SessionSheetBar
								agentIds={openedSessionIds}
								agents={agents}
								projects={projects}
								activeAgentId={activeAgentId}
								sidebarCollapsed={sidebarCollapsed}
								rightPanelCollapsed={rightPanelCollapsed}
								onSelect={handleSelectAgent}
								onClose={handleCloseSessionSheet}
								onReorder={handleReorderSessionSheets}
								onExpandSidebar={handleExpandSidebar}
								onExpandRightPanel={handleExpandRightPanel}
							/>
							{activeAgent ? (
								<ChatPanel
									agentId={activeAgent.id}
									agentName={activeAgent.name}
									sessionState={activeSessionState}
									autoCollapse={autoCollapse}
									queue={activeQueue}
									phase={activePhase}
									currentModel={activeAgent.model}
									currentThinking={activeAgent.thinkingLevel}
									availableThinkingLevels={thinkingLevels}
									onSend={handleSendMessage}
									onThinkingChange={handleThinkingChange}
									onModelChange={handleModelChanged}
									onRequestApiKeys={handleRequestApiKeys}
									onAbort={handleAbortAgent}
									onDequeueAll={handleDequeueAll}
								/>
							) : agents.length > 0 ? (
								<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
									选择左侧会话查看消息
								</div>
							) : appReadyPhase >= 2 ? (
								<EmptySessionState activeProject={activeProject} handleCreateClick={handleCreateClick} />
							) : null}
						</>
					)}
				</main>

				<RightPanel />

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
				{showSettings && (
					<SettingsDialog
						open={showSettings}
						providers={providerSettings.providers}
						customStats={providerSettings.customStats}
						onProvidersChange={onProvidersChange}
						onClose={handleCloseSettings}
						defaultTab={settingsTab}
					/>
				)}
				<PermissionDialog />
				<PlanQuestionDialog key={`plan-question:${activeAgentId ?? "none"}`} sessionId={activeAgentId} />
				<PlanApprovalDialog key={`plan-approval:${activeAgentId ?? "none"}`} sessionId={activeAgentId} />
			</div>
			<UpdateNotification />
		</>
	);
}

// memo 包裹：App.tsx 订阅了大量 atom（如 showSettingsAtom）,任何 atom
// 变化都会让 App 重新执行。用 memo 让 props 没变化的常见状态更新（如
// showAgentSquare / settingsTab 等被切换时）跳过整棵子树重渲染。
// 关键依赖上游的父组件已经稳定所有回调与对象引用(useMemo/useCallback)。
export default memo(AppLayout);
