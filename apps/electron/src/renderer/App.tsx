// ============================================================
// App — Thin orchestrator: 组合 hooks，处理登录态守卫，渲染 AppLayout
// ============================================================

import { useAtomValue } from "jotai";
import { useCallback, useEffect } from "react";
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
	hasAgentsAtom,
	projectsAtom,
	providerSettingsAtom,
	rightPanelCollapsedAtom,
	sidebarCollapsedAtom,
} from "./store/atoms";
import { dockPanelWidthAtom, generalSettingsHydratedAtom, rightPanelWidthAtom } from "./store/projectAtoms";

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
	const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
	const dockPanelWidth = useAtomValue(dockPanelWidthAtom);
	const generalSettingsHydrated = useAtomValue(generalSettingsHydratedAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const hasAgents = useAtomValue(hasAgentsAtom);
	const projects = useAtomValue(projectsAtom);

	// ── Hooks ──
	const agentActions = useAgentActions();
	const projectActions = useProjectActions();
	useAppEffects();

	// ── Layout callbacks ──
	const onProvidersChange = useCallback((data: ProviderSettingsData) => appStore.set(providerSettingsAtom, data), []);

	useEffect(() => {
		// 设置加载完成前不持久化布局值：避免启动首帧把默认宽度/折叠态写回
		// 设置覆盖用户已存值（2026-08-07）。
		// 拖尾防抖：面板拖拽时 rightPanelWidth/dockPanelWidth 以 ~60Hz 变化，
		// 直接发 IPC 会产生数百次 invoke；与 useAppEffects 的持久化防抖同模式，
		// 每次拖拽手势收敛为一次写入。
		if (!api || !generalSettingsHydrated) return;
		const timer = setTimeout(() => {
			api.setGeneralSettings({ sidebarCollapsed, rightPanelCollapsed, rightPanelWidth, dockPanelWidth }).catch(
				(err) => console.warn("[App] setGeneralSettings failed:", err),
			);
		}, 200);
		return () => clearTimeout(timer);
	}, [sidebarCollapsed, rightPanelCollapsed, rightPanelWidth, dockPanelWidth, generalSettingsHydrated]);

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
			hasAgents={hasAgents}
			activeAgent={activeAgent}
			activeAgentId={activeAgentId}
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
			handleSwitchProject={projectActions.handleSwitchProject}
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
