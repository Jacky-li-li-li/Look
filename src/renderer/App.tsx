// ============================================================
// App — Ink Wash Design System (shadcn/ui)
//
// Post-Jotai: all core state lives in atoms (store/atoms.ts).
// IPC events are handled outside React by store/ipcHandler.ts.
// Components subscribe only to the atoms they care about, so e.g.
// agent:usage-update only re-renders the Sidebar row, not ChatPanel.
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Separator } from "@shared/components/ui/separator";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import type { ProjectInfo, ThinkingLevel } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import { FolderOpen } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ChatPanel from "./components/ChatPanel";
import DeleteProjectDialog from "./components/DeleteProjectDialog";
import LoginScreen from "./components/LoginScreen";
import NewProjectDialog from "./components/NewProjectDialog";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import Sidebar from "./components/Sidebar";
import SettingsDialog from "./components/settings/SettingsDialog";
import UpdateNotification from "./components/UpdateNotification";
import WelcomeScreen from "./components/WelcomeScreen";
import { preloadHighlighter } from "./lib/highlighter";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	activeProjectAtom,
	activeProjectIdAtom,
	autoCollapseAtom,
	messagesAtomFamily,
	openProjectIdsAtom,
	pendingDeleteProjectAtom,
	projectsAtom,
	providerSettingsAtom,
	queuesAtomFamily,
	settingsTabAtom,
	showSettingsAtom,
	userPreferredModelAtom,
} from "./store/atoms";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "./store/authAtoms";
import { appStore } from "./store/ipcHandler";

preloadHighlighter();

const api = (window as any).look;

export default function App() {
	const { t } = useTranslation();

	// ---- Auth state ----
	const [isLoggedIn, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [authLoading, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	// ---- Read atoms ----
	const activeAgent = useAtomValue(activeAgentAtom);
	const autoCollapse = useAtomValue(autoCollapseAtom);
	const showSettings = useAtomValue(showSettingsAtom);
	const settingsTab = useAtomValue(settingsTabAtom);
	const providerSettings = useAtomValue(providerSettingsAtom);
	const activeProject = useAtomValue(activeProjectAtom);

	// Messages and queue for the active agent (atomFamily).
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeMessages = useAtomValue(messagesAtomFamily(activeAgentId ?? ""));
	const activeQueue = useAtomValue(queuesAtomFamily(activeAgentId ?? ""));

	// ---- Project state ----
	const projects = useAtomValue(projectsAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const pendingDelete = useAtomValue(pendingDeleteProjectAtom);
	const openProjectIds = useAtomValue(openProjectIdsAtom);
	const [newProjectCwd, setNewProjectCwd] = useState<string | null>(null);

	// ---- Project callbacks ----

	const handleOpenProject = useCallback(async () => {
		if (!api) return;
		const result = await api.openDirectoryDialog(t("project.openProject", "Open project folder"));
		if (!result?.success || !result.path) return;
		setNewProjectCwd(result.path);
	}, [t]);

	const handleDeleteProject = useCallback((project: ProjectInfo) => {
		// Trigger confirmation flow
		api.deleteProject(project.id);
	}, []);

	const handleProjectCreated = useCallback(async (projectId: string) => {
		appStore.set(activeProjectIdAtom, projectId);
		appStore.set(activeAgentIdAtom, null);
		// Refresh project list
		const r = await api.listProjects().catch(() => null);
		if (r?.success) {
			appStore.set(projectsAtom, r.projects);
		}
	}, []);

	const handleDeleteProjectCancelled = useCallback(() => {
		appStore.set(pendingDeleteProjectAtom, null);
	}, []);

	const handleDeleteProjectConfirmed = useCallback(() => {
		appStore.set(pendingDeleteProjectAtom, null);
		api.listProjects()
			.then((r: any) => {
				if (r?.success) appStore.set(projectsAtom, r.projects);
			})
			.catch(() => {});
	}, []);

	// ---- Callbacks: use appStore.get() to read latest value, avoiding stale closures ----

	const handleSendMessage = useCallback((text: string) => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return;
		api.sendMessage(id, text);
	}, []);

	const handleSelectAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		const result = await api.activateSession(agentId);
		if (result?.success) appStore.set(activeAgentIdAtom, agentId);
	}, []);

	const handleDestroyAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		await api.destroyAgent(agentId);
	}, []);

	const handleAbortAgent = useCallback(async () => {
		const id = appStore.get(activeAgentIdAtom);
		if (!api || !id) return;
		try {
			await api.abortAgent(id);
		} catch (err: any) {
			toast.error(`Stop failed: ${err?.message ?? "unknown"}`);
		}
	}, []);

	const handleThinkingChange = useCallback(async (level: string) => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id || !api) return;
		await api.updateThinking(id, level);
	}, []);

	const handleModelChanged = useCallback((newModel: string) => {
		appStore.set(userPreferredModelAtom, newModel);
		if (api) api.setGeneralSettings({ preferredModel: newModel }).catch(() => {});
	}, []);

	const handleCreateClick = useCallback(async (projectId: string) => {
		if (!api) return;
		const result = await api.createAgent({ projectId });
		if (result?.success && result.agentId) appStore.set(activeAgentIdAtom, result.agentId);
	}, []);

	const handleRenameProject = useCallback(async (projectId: string, name: string) => {
		if (!api || !name.trim()) return;
		const result = await api.renameProject(projectId, name.trim());
		if (!result?.success) toast.error(result?.error ?? "Failed to rename project");
	}, []);

	const handleOpenProjectFolderById = useCallback(async (projectId: string) => {
		if (!api) return;
		const result = await api.openProjectFolder(projectId).catch(() => null);
		if (!result?.success) toast.error(result?.error ?? "Failed to open project folder");
	}, []);

	const handleSettingsClick = useCallback(() => {
		appStore.set(settingsTabAtom, "general");
		appStore.set(showSettingsAtom, true);
	}, []);

	const handleRequestApiKeys = useCallback(() => {
		appStore.set(settingsTabAtom, "api-keys");
		appStore.set(showSettingsAtom, true);
	}, []);

	const handleCloseSettings = useCallback(() => appStore.set(showSettingsAtom, false), []);

	const handleOpenProjectFolder = useCallback(() => {
		try {
			const fn = api?.openProjectFolder;
			if (typeof fn !== "function") {
				toast.error("API not available — restart the app to reload preload.");
				return;
			}
			fn(activeAgent?.projectId).catch((err: any) =>
				toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`),
			);
		} catch (err: any) {
			toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`);
		}
	}, [activeAgent?.projectId]);

	// ---- Side effects ----

	// Auth session restore on mount
	useEffect(() => {
		if (!api) return;
		const configured = isSupabaseConfigured();

		async function restoreSession() {
			if (!configured) {
				// No Supabase config — skip login entirely, operate as before
				setIsLoggedIn(true);
				setAuthLoading(false);
				return;
			}

			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (session?.user) {
				// Restore from cloud
				const { data: cloudProfile } = await supabase
					.from("user_profiles")
					.select("user_name, avatar")
					.eq("id", session.user.id)
					.single();

				if (cloudProfile) {
					setUserProfile({
						userId: session.user.id,
						email: session.user.email ?? "",
						userName: cloudProfile.user_name || session.user.email || "",
						avatar: cloudProfile.avatar || "",
					});
				} else {
					// Fallback to local
					try {
						const r = await api.getUserProfile();
						if (r?.success && r.profile?.userId === session.user.id) {
							setUserProfile(r.profile);
						} else {
							setUserProfile({
								userId: session.user.id,
								email: session.user.email ?? "",
								userName: session.user.email ?? "",
								avatar: "",
							});
						}
					} catch {
						setUserProfile({
							userId: session.user.id,
							email: session.user.email ?? "",
							userName: session.user.email ?? "",
							avatar: "",
						});
					}
				}
				setIsLoggedIn(true);
			} else {
				// No session — try local profile as fallback
				try {
					const r = await api.getUserProfile();
					if (r?.success && r.profile?.userId) {
						setUserProfile(r.profile);
						setIsLoggedIn(true);
						setAuthLoading(false);
						return;
					}
				} catch {}
				setIsLoggedIn(false);
			}
			setAuthLoading(false);
		}

		restoreSession();
	}, [setAuthLoading, setIsLoggedIn, setUserProfile]);

	// Persist active agent ID and project ID with debounce.
	useEffect(() => {
		if (!api) return;
		const timer = setTimeout(() => {
			const payload: Record<string, any> = {};
			if (activeAgentId) payload.lastActiveSessionId = activeAgentId;
			if (activeProjectId) payload.lastActiveProjectId = activeProjectId;
			payload.openProjectIds = openProjectIds;
			if (Object.keys(payload).length > 0) {
				api.setGeneralSettings(payload).catch(() => {});
			}
		}, 500);
		return () => clearTimeout(timer);
	}, [activeAgentId, activeProjectId, openProjectIds]);

	// The main process mirrors this list directly from pi's
	// AgentSession.getAvailableThinkingLevels(). Do not infer model families here.
	const thinkingLevels = useMemo(() => {
		const levels =
			activeAgent?.availableThinkingLevels && activeAgent.availableThinkingLevels.length > 0
				? activeAgent.availableThinkingLevels
				: (["off"] as ThinkingLevel[]);
		return levels;
	}, [activeAgent?.availableThinkingLevels]);

	// ---- Render ----

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

	// Loading state while checking session
	if (isSupabaseConfigured() && authLoading) {
		return (
			<div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
				<PixelAgentAvatar size="lg" active />
				<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
				<p className="text-xs text-muted-foreground">{t("common.loading")}</p>
			</div>
		);
	}

	// Auth guard — show LoginScreen when Supabase is configured and user is not logged in
	if (isSupabaseConfigured() && !isLoggedIn) {
		return <LoginScreen />;
	}

	return (
		<ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
			<TooltipProvider>
				<div className="app-shell flex h-screen overflow-hidden bg-background p-2">
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

					<Separator orientation="vertical" className="mx-2 bg-transparent" />

					<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-background">
						{!api ? null : projects.length === 0 ? (
							<WelcomeScreen onOpenProject={handleOpenProject} />
						) : activeAgent ? (
							<>
								<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-hairline px-4">
									<div className="flex min-w-0 items-center gap-3">
										<PixelAgentAvatar status={activeAgent.status} size="sm" active />
										<div className="min-w-0">
											<div className="flex min-w-0 items-center gap-2">
												<h1 className="truncate text-[13px] font-semibold">{activeAgent.name}</h1>
											</div>
										</div>
									</div>
									<div className="flex items-center gap-1">
										<Button
											size="icon"
											variant="ghost"
											className="size-7"
											onClick={handleOpenProjectFolder}
											aria-label="Open session storage"
											title="Open project folder"
										>
											<FolderOpen className="size-3.5" />
										</Button>
									</div>
								</header>

								<ChatPanel
									agentId={activeAgent.id}
									agentName={activeAgent.name}
									messages={activeMessages}
									autoCollapse={autoCollapse}
									queue={activeQueue}
									agentStatus={activeAgent.status}
									currentModel={activeAgent.model}
									currentThinking={activeAgent.thinkingLevel}
									availableThinkingLevels={thinkingLevels}
									onSend={handleSendMessage}
									onThinkingChange={handleThinkingChange}
									onModelChange={handleModelChanged}
									onRequestApiKeys={handleRequestApiKeys}
									onAbort={handleAbortAgent}
								/>
							</>
						) : (
							<div className="flex flex-1 items-center justify-center p-10 text-center">
								<div className="flex max-w-sm flex-col items-center gap-3">
									<div className="flex size-12 items-center justify-center rounded-xl border border-hairline bg-accent/20">
										<FolderOpen className="size-5 text-muted-foreground" />
									</div>
									<p className="text-sm font-medium">
										{activeProject?.name ?? t("workspace.noSessionSelected", "No session selected")}
									</p>
									<p className="text-xs text-muted-foreground">
										{t("workspace.emptyProjectHint", "Create a session inside a workspace to begin.")}
									</p>
									{activeProject?.valid && (
										<Button variant="line" size="sm" onClick={() => handleCreateClick(activeProject.id)}>
											{t("sidebar.newSession", "New session")}
										</Button>
									)}
								</div>
							</div>
						)}
					</main>

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
							providers={providerSettings}
							onProvidersChange={(ps) => appStore.set(providerSettingsAtom, ps)}
							onClose={handleCloseSettings}
							defaultTab={settingsTab}
						/>
					)}
				</div>
			</TooltipProvider>
			<UpdateNotification />
		</ThemeProvider>
	);
}
