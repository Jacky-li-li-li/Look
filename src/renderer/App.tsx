// ============================================================
// App — Thin orchestrator: 组合 hooks，处理登录态守卫，渲染 AppLayout
// ============================================================

import { useAtom, useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import AppLayout from "./components/AppLayout";
import LoginScreen from "./components/LoginScreen";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import { useAgentActions } from "./hooks/useAgentActions";
import { useAppEffects } from "./hooks/useAppEffects";
import { useAuthSession } from "./hooks/useAuthSession";
import { useProjectActions } from "./hooks/useProjectActions";
import { isSupabaseConfigured } from "./lib/supabase";
import type { ProviderSettingsData } from "./store/atoms";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	activeProjectAtom,
	agentsAtom,
	autoCollapseAtom,
	openedSessionIdsAtom,
	pendingDeleteProjectAtom,
	projectsAtom,
	providerSettingsAtom,
	rightPanelCollapsedAtom,
	sessionStateAtomFamily,
	settingsTabAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
	showSettingsAtom,
	sidebarCollapsedAtom,
} from "./store/atoms";
import { appStore } from "./store/ipcHandler";
import { deriveSessionPhase } from "./store/sessionTypes";

const api = window.look;

export default function App() {
	const { t } = useTranslation();

	// ── Auth ──
	const { isLoggedIn, authLoading } = useAuthSession();

	// ── Atom reads ──
	const activeAgent = useAtomValue(activeAgentAtom);
	const autoCollapse = useAtomValue(autoCollapseAtom);
	const showSettings = useAtomValue(showSettingsAtom);
	const settingsTab = useAtomValue(settingsTabAtom);
	const providerSettings = useAtomValue(providerSettingsAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
	const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom);
	const [showAgentSquare] = useAtom(showAgentSquareAtom);
	const showScheduledTasks = useAtomValue(showScheduledTasksAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeSessionState = useAtomValue(sessionStateAtomFamily(activeAgentId ?? ""));
	const activeQueue = useMemo(() => {
		// 优先使用 UI 事件路径（流式期间实时更新），
		// 回退到 runtime snapshot（持久化状态）
		const uiSteering = activeSessionState.uiSteering ?? [];
		const uiFollowUp = activeSessionState.uiFollowUp ?? [];
		if (uiSteering.length > 0 || uiFollowUp.length > 0) {
			return { steering: [...uiSteering], followUp: [...uiFollowUp] };
		}
		return {
			steering: [...(activeSessionState.runtime?.steering ?? [])],
			followUp: [...(activeSessionState.runtime?.followUp ?? [])],
		};
	}, [
		activeSessionState.uiSteering,
		activeSessionState.uiFollowUp,
		activeSessionState.runtime?.steering,
		activeSessionState.runtime?.followUp,
	]);
	const activePhase = deriveSessionPhase(activeSessionState);
	const agents = useAtomValue(agentsAtom);
	const [openedSessionIds] = useAtom(openedSessionIdsAtom);
	const projects = useAtomValue(projectsAtom);
	const pendingDelete = useAtomValue(pendingDeleteProjectAtom);

	// ── Hooks ──
	const agentActions = useAgentActions();
	const projectActions = useProjectActions();
	const { thinkingLevels } = useAppEffects();

	// ── Layout callbacks ──
	const handleSettingsClick = useCallback(() => {
		appStore.set(settingsTabAtom, "general");
		appStore.set(showSettingsAtom, true);
	}, []);
	const handleRequestApiKeys = useCallback(() => {
		appStore.set(settingsTabAtom, "api-keys");
		appStore.set(showSettingsAtom, true);
	}, []);
	const handleCloseSettings = useCallback(() => appStore.set(showSettingsAtom, false), []);
	const handleExpandSidebar = useCallback(() => appStore.set(sidebarCollapsedAtom, false), []);
	const handleExpandRightPanel = useCallback(() => appStore.set(rightPanelCollapsedAtom, false), []);
	const onProvidersChange = useCallback((data: ProviderSettingsData) => appStore.set(providerSettingsAtom, data), []);

	// ── Early return guards ──
	if (!api) {
		return (
			<div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
				<PixelAgentAvatar size="lg" active />
				<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
				<p className="text-sm text-destructive">Harness API not available.</p>
				<p className="text-xs text-muted-foreground">
					Run with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">npm run dev</code> inside
					Electron.
				</p>
			</div>
		);
	}

	if (isSupabaseConfigured() && authLoading) {
		return (
			<div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
				<PixelAgentAvatar size="lg" active />
				<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
				<p className="text-xs text-muted-foreground">{t("common.loading")}</p>
			</div>
		);
	}

	if (isSupabaseConfigured() && !isLoggedIn) {
		return <LoginScreen />;
	}

	// ── Main layout ──
	return (
		<AppLayout
			sidebarCollapsed={sidebarCollapsed}
			rightPanelCollapsed={rightPanelCollapsed}
			agents={agents}
			openedSessionIds={openedSessionIds}
			activeAgent={activeAgent}
			activeAgentId={activeAgentId}
			activeSessionState={activeSessionState}
			activeQueue={activeQueue}
			activePhase={activePhase}
			autoCollapse={autoCollapse}
			thinkingLevels={thinkingLevels}
			projects={projects}
			activeProject={activeProject}
			showAgentSquare={showAgentSquare}
			showScheduledTasks={showScheduledTasks}
			newProjectCwd={projectActions.newProjectCwd}
			setNewProjectCwd={projectActions.setNewProjectCwd}
			pendingDelete={pendingDelete}
			showSettings={showSettings}
			settingsTab={settingsTab}
			providerSettings={providerSettings}
			handleSendMessage={agentActions.handleSendMessage}
			handleSelectAgent={agentActions.handleSelectAgent}
			handleCloseSessionSheet={agentActions.handleCloseSessionSheet}
			handleReorderSessionSheets={agentActions.handleReorderSessionSheets}
			handleDestroyAgent={agentActions.handleDestroyAgent}
			handleAbortAgent={agentActions.handleAbortAgent}
			handleDequeueAll={agentActions.handleDequeueAll}
			handleThinkingChange={agentActions.handleThinkingChange}
			handleModelChanged={agentActions.handleModelChanged}
			handleCreateClick={agentActions.handleCreateClick}
			handleRequestApiKeys={handleRequestApiKeys}
			handleOpenProject={projectActions.handleOpenProject}
			handleDeleteProject={projectActions.handleDeleteProject}
			handleProjectCreated={projectActions.handleProjectCreated}
			handleDeleteProjectCancelled={projectActions.handleDeleteProjectCancelled}
			handleDeleteProjectConfirmed={projectActions.handleDeleteProjectConfirmed}
			handleRenameProject={projectActions.handleRenameProject}
			handleOpenProjectFolderById={projectActions.handleOpenProjectFolderById}
			handleSettingsClick={handleSettingsClick}
			handleCloseSettings={handleCloseSettings}
			handleExpandSidebar={handleExpandSidebar}
			handleExpandRightPanel={handleExpandRightPanel}
			onProvidersChange={onProvidersChange}
		/>
	);
}
