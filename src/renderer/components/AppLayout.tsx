// ============================================================
// AppLayout — 主应用布局（Sidebar + 主内容区 + RightPanel + Dialogs）
// ============================================================

import { Separator } from "@shared/components/ui/separator";
import type { AgentInfo, ImageContent, ProjectInfo, ThinkingLevel } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";
import { appReadyPhaseAtom, type ProviderSettingsData, type SettingsTab } from "../store/atoms";
import type { RendererSessionPhase, RendererSessionState } from "../store/sessionTypes";
import AgentSquare from "./AgentMarketplace/AgentSquare";
import ChatPanel from "./chat/ChatPanel";
import DeleteProjectDialog from "./dialogs/DeleteProjectDialog";
import EmptySessionState from "./chat/EmptySessionState";
import NewProjectDialog from "./dialogs/NewProjectDialog";
import PermissionDialog from "./dialogs/PermissionDialog";
import PlanApprovalDialog from "./dialogs/PlanApprovalDialog";
import PlanQuestionDialog from "./dialogs/PlanQuestionDialog";
import { RightPanel } from "./workspace/RightPanel";
import SessionSheetBar from "./SessionSheetBar";
import Sidebar from "./Sidebar";
import SettingsDialog from "./settings/SettingsDialog";
import UpdateNotification from "./dialogs/UpdateNotification";
import WelcomeScreen from "./chat/WelcomeScreen";

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
	const appReadyPhase = useAtomValue(appReadyPhaseAtom);

	// 首帧渲染后标记 data-app-ready，CSS 可据此禁用初始加载过渡
	useEffect(() => {
		const el = document.documentElement;
		el.setAttribute("data-app-ready", "false");
		const raf = requestAnimationFrame(() => {
			el.setAttribute("data-app-ready", "true");
		});
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<>
			<div
				className="app-shell flex h-screen overflow-hidden bg-background p-2"
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

				<Separator orientation="vertical" className="sidebar-separator mx-1 bg-transparent" />

				<main className="flex min-w-[340px] flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-background">
					{appReadyPhase < 1 ? null : projects.length === 0 ? (
						<WelcomeScreen onOpenProject={handleOpenProject} />
					) : showAgentSquare ? (
						<AgentSquare />
					) : (
						<>
							<SessionSheetBar
								agentIds={openedSessionIds}
								agents={agents}
								projects={projects}
								activeAgentId={activeAgentId}
								sidebarCollapsed={sidebarCollapsed}
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
							) : appReadyPhase >= 2 && agents.length === 0 ? (
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
