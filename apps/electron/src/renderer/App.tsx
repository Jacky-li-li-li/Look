// ============================================================
// App — Thin orchestrator: 组合 hooks，处理登录态守卫，渲染 AppLayout
// ============================================================

import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import AppLayout from "./components/AppLayout";
import { BrandMark } from "./components/BrandMark";
import LoginScreen from "./components/LoginScreen";
import { useAgentActions } from "./hooks/useAgentActions";
import { useAppEffects } from "./hooks/useAppEffects";
import { useAuthSession } from "./hooks/useAuthSession";
import { useProjectActions } from "./hooks/useProjectActions";
import { isSupabaseConfigured } from "./lib/supabase";
import { appStore } from "./store/appStore";
import type { ProviderSettingsData } from "./store/atoms";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	agentsAtom,
	projectsAtom,
	providerSettingsAtom,
	rightPanelCollapsedAtom,
	sessionStateAtomFamily,
	sidebarCollapsedAtom,
} from "./store/atoms";
import { deriveActiveQueue, deriveSessionPhase } from "./store/sessionTypes";

const api = window.look;

export default function App() {
	// ── Auth ──
	const { isLoggedIn } = useAuthSession();

	// ── Atom reads ──
	const activeAgent = useAtomValue(activeAgentAtom);
	const providerSettings = useAtomValue(providerSettingsAtom);
	// sidebarCollapsed/rightPanelCollapsed 保留在此：切换时持久化到 GeneralSettings。
	const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
	const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeSessionState = useAtomValue(sessionStateAtomFamily(activeAgentId ?? ""));
	const activeQueue = useMemo(() => deriveActiveQueue(activeSessionState), [activeSessionState]);
	const activePhase = deriveSessionPhase(activeSessionState);
	const agents = useAtomValue(agentsAtom);
	const projects = useAtomValue(projectsAtom);

	// ── Hooks ──
	const agentActions = useAgentActions();
	const projectActions = useProjectActions();
	useAppEffects();

	// ── Layout callbacks ──
	const onProvidersChange = useCallback((data: ProviderSettingsData) => appStore.set(providerSettingsAtom, data), []);

	useEffect(() => {
		if (!api) return;
		api.setGeneralSettings({ sidebarCollapsed, rightPanelCollapsed }).catch((err) =>
			console.warn("[App] setGeneralSettings failed:", err),
		);
	}, [sidebarCollapsed, rightPanelCollapsed]);

	// ── Early return guards ──
	if (!api) {
		return (
			<div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
				<BrandMark />
				<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
				<p className="text-sm text-destructive">Harness API not available.</p>
				<p className="text-xs text-muted-foreground">
					Run with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">npm run dev</code> inside
					Electron.
				</p>
			</div>
		);
	}

	if (isSupabaseConfigured() && !isLoggedIn) {
		return <LoginScreen />;
	}

	// ── Main layout ──
	return (
		<AppLayout
			agents={agents}
			activeAgent={activeAgent}
			activeAgentId={activeAgentId}
			activeSessionState={activeSessionState}
			activeQueue={activeQueue}
			activePhase={activePhase}
			projects={projects}
			newProjectCwd={projectActions.newProjectCwd}
			setNewProjectCwd={projectActions.setNewProjectCwd}
			providerSettings={providerSettings}
			handleSendMessage={agentActions.handleSendMessage}
			handleSelectAgent={agentActions.handleSelectAgent}
			handleDestroyAgent={agentActions.handleDestroyAgent}
			handleAbortAgent={agentActions.handleAbortAgent}
			handleThinkingChange={agentActions.handleThinkingChange}
			handleModelChanged={agentActions.handleModelChanged}
			handleCreateClick={agentActions.handleCreateClick}
			handleOpenProject={projectActions.handleOpenProject}
			handleDeleteProject={projectActions.handleDeleteProject}
			handleProjectCreated={projectActions.handleProjectCreated}
			handleDeleteProjectCancelled={projectActions.handleDeleteProjectCancelled}
			handleDeleteProjectConfirmed={projectActions.handleDeleteProjectConfirmed}
			handleRenameProject={projectActions.handleRenameProject}
			handleOpenProjectFolderById={projectActions.handleOpenProjectFolderById}
			onProvidersChange={onProvidersChange}
		/>
	);
}
