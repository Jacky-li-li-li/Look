// ============================================================
// App — Ink Wash Design System (shadcn/ui)
//
// Post-Jotai: all core state lives in atoms (store/atoms.ts).
// IPC events are handled outside React by store/ipcHandler.ts.
// Components subscribe only to the atoms they care about, so e.g.
// agent:usage-update only re-renders the Sidebar row, not ChatPanel.
// ============================================================

import type { PermissionMode, ProjectInfo, ThinkingLevel } from "@shared/types";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@shared/components/ui/button";
import { Separator } from "@shared/components/ui/separator";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import { useAtom, useAtomValue } from "jotai";
import { ThemeProvider } from "next-themes";
import AgentCreateDialog from "./components/AgentCreateDialog";
import ChatPanel from "./components/ChatPanel";
import DeleteProjectDialog from "./components/DeleteProjectDialog";
import NewProjectDialog from "./components/NewProjectDialog";
import { PermissionDialog } from "./components/PermissionDialog";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";
import WelcomeScreen from "./components/WelcomeScreen";
import { preloadHighlighter } from "./lib/highlighter";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	activeProjectAtom,
	activeProjectIdAtom,
	agentsAtom,
	autoCollapseAtom,
	defaultModelForCreateAtom,
	messagesAtomFamily,
	pendingAsksAtom,
	pendingDeleteProjectAtom,
	projectsAtom,
	providerSettingsAtom,
	queuesAtomFamily,
	showCreateDialogAtom,
	showSettingsAtom,
	settingsTabAtom,
	userPreferredModelAtom,
} from "./store/atoms";
import { appStore } from "./store/ipcHandler";

preloadHighlighter();

const api = (window as any).look;

export default function App() {
	const { t } = useTranslation();

	// ---- Read atoms ----
	const activeAgent = useAtomValue(activeAgentAtom);
	const autoCollapse = useAtomValue(autoCollapseAtom);
	const showCreateDialog = useAtomValue(showCreateDialogAtom);
	const defaultModelForCreate = useAtomValue(defaultModelForCreateAtom);
	const showSettings = useAtomValue(showSettingsAtom);
	const settingsTab = useAtomValue(settingsTabAtom);
	const providerSettings = useAtomValue(providerSettingsAtom);
	const pendingAsks = useAtomValue(pendingAsksAtom);
	const pendingAsk = pendingAsks[0] ?? null;
	const pendingQueueDepth = pendingAsks.length;

	// Messages and queue for the active agent (atomFamily).
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeMessages = useAtomValue(messagesAtomFamily(activeAgentId ?? ""));
	const activeQueue = useAtomValue(queuesAtomFamily(activeAgentId ?? ""));

	// ---- Project state ----
	const projects = useAtomValue(projectsAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const pendingDelete = useAtomValue(pendingDeleteProjectAtom);
	const [newProjectCwd, setNewProjectCwd] = useState<string | null>(null);

	// ---- Project callbacks ----

	const handleSelectProject = useCallback((projectId: string) => {
		if (!api) return;
		appStore.set(activeProjectIdAtom, projectId);
		api.switchProject(projectId)
			.then((r: any) => {
				if (r?.success) {
					if (Array.isArray(r.agents)) appStore.set(agentsAtom, r.agents);
					if (r.history) {
						for (const [agentId, msgs] of Object.entries(r.history)) {
							if (Array.isArray(msgs) && msgs.length > 0) {
								appStore.set(messagesAtomFamily(agentId), msgs as any);
							}
						}
					}
				}
			})
			.catch(() => {});
		// Persist last active project
		api.setGeneralSettings({}).catch(() => {});
	}, []);

	const handleOpenProject = useCallback(async () => {
		if (!api) return;
		const result = await api.openDirectoryDialog();
		if (!result?.success || !result.path) return;
		setNewProjectCwd(result.path);
	}, []);

	const handleCreateProject = useCallback(async (cwd: string, name?: string) => {
		if (!api) return;
		const r = await api.createProject(cwd, name);
		if (r?.success) {
			if (r.isDuplicate) {
				toast("Project already open", { description: "Switched to existing project." });
			}
			appStore.set(
				projectsAtom,
				await api
					.listProjects()
					.then((pr: any) => pr?.projects ?? [])
					.catch(() => []),
			);
			// Pull agents for new project
			const ar = await api.getAgents().catch(() => null);
			if (ar?.success) {
				if (Array.isArray(ar.agents)) appStore.set(agentsAtom, ar.agents);
			}
		} else {
			toast.error(r?.error ?? "Failed to create project");
		}
	}, []);

	const handleDeleteProject = useCallback((project: ProjectInfo) => {
		// Trigger confirmation flow
		api.deleteProject(project.id);
	}, []);

	const handleProjectCreated = useCallback(async (projectId: string) => {
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
		const p = appStore.get(pendingDeleteProjectAtom);
		if (!p) return;
		api.confirmDeleteProject(p.projectId, true);
		appStore.set(pendingDeleteProjectAtom, null);
		// Refresh
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

	const handleSelectAgent = useCallback((agentId: string) => {
		appStore.set(activeAgentIdAtom, agentId);
	}, []);

	const handleCreateAgent = useCallback(async (name: string, role: string, model?: string, thinkingLevel?: string) => {
		if (!api) return;
		const parentId = appStore.get(activeAgentIdAtom);
		const result = await api.createAgent(name, role, model, thinkingLevel, parentId);
		if (result?.success && result.agentId) appStore.set(activeAgentIdAtom, result.agentId);
		appStore.set(showCreateDialogAtom, false);
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
		// Optimistic update (agent:updated IPC also fires).
		const agents = appStore.get(agentsAtom);
		appStore.set(
			agentsAtom,
			agents.map((a) => (a.id === id ? { ...a, thinkingLevel: level as ThinkingLevel } : a)),
		);
	}, []);

	const handleModelChanged = useCallback((newModel: string) => {
		appStore.set(userPreferredModelAtom, newModel);
		if (api) api.setGeneralSettings({ preferredModel: newModel }).catch(() => {});
	}, []);

	const handleCreateClick = useCallback((defaultModel?: string) => {
		if (defaultModel !== undefined) appStore.set(defaultModelForCreateAtom, defaultModel);
		appStore.set(showCreateDialogAtom, true);
	}, []);

	const handleSettingsClick = useCallback(() => {
		appStore.set(settingsTabAtom, "general");
		appStore.set(showSettingsAtom, true);
	}, []);

	const handleRequestApiKeys = useCallback(() => {
		appStore.set(settingsTabAtom, "api-keys");
		appStore.set(showSettingsAtom, true);
	}, []);

	const handleQuickCreateChat = useCallback(async () => {
		if (!api) return;
		const agent = appStore.get(activeAgentAtom);
		const prefModel = appStore.get(userPreferredModelAtom);
		const seedModel = agent?.model ?? prefModel ?? undefined;
		const parentId = appStore.get(activeAgentIdAtom);
		const r = await api.createAgent("聊天助手", "chat", seedModel, undefined, parentId);
		if (r?.success && r.agentId) appStore.set(activeAgentIdAtom, r.agentId);
	}, []);

	const handleCloseSettings = useCallback(() => appStore.set(showSettingsAtom, false), []);
	const handleCloseCreateDialog = useCallback(() => {
		appStore.set(showCreateDialogAtom, false);
		appStore.set(defaultModelForCreateAtom, undefined);
	}, []);

	const handleOpenProjectFolder = useCallback(() => {
		try {
			const fn = api?.openProjectFolder;
			if (typeof fn !== "function") {
				toast.error("API not available — restart the app to reload preload.");
				return;
			}
			fn().catch((err: any) => toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`));
		} catch (err: any) {
			toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`);
		}
	}, []);

	// ---- Permission dialog ----

	const drainAsk = useCallback(
		(action: "allow" | "deny" | "edit", extras?: { reason?: string; args?: Record<string, unknown> }) => {
			const asks = appStore.get(pendingAsksAtom);
			if (asks.length === 0) return;
			const [head, ...rest] = asks;
			appStore.set(pendingAsksAtom, rest);
			api.respondPermission({ action, requestId: head.requestId, ...extras })
				.then((r: any) => {
					if (!r?.success) {
						toast.error(`Permission response failed: ${r?.error ?? "unknown"}`);
					} else if (action === "allow") {
						toast.success(`Allowed: ${head.toolName}`, { duration: 1500 });
					} else if (action === "deny") {
						toast(`Denied: ${head.toolName}`, { description: head.reason, duration: 2000 });
					} else {
						toast.success(`Allowed (edited): ${head.toolName}`, { duration: 1500 });
					}
				})
				.catch(() => toast.error("Failed to send permission response"));
		},
		[],
	);

	const handlePermissionAllow = useCallback(() => drainAsk("allow"), [drainAsk]);
	const handlePermissionDeny = useCallback(() => drainAsk("deny"), [drainAsk]);
	const handlePermissionEdit = useCallback((args: Record<string, unknown>) => drainAsk("edit", { args }), [drainAsk]);

	const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
		const id = appStore.get(activeAgentIdAtom);
		if (!id) return;
		const agents = appStore.get(agentsAtom);
		appStore.set(
			agentsAtom,
			agents.map((a) => (a.id === id ? { ...a, permissionMode: mode } : a)),
		);
		api.setPermissionMode(id, mode);
	}, []);

	// ---- Side effects ----

	// Persist active agent ID and project ID with debounce.
	useEffect(() => {
		if (!api) return;
		const timer = setTimeout(() => {
			const payload: Record<string, any> = {};
			if (activeAgentId) payload.lastActiveAgentId = activeAgentId;
			if (activeProjectId) payload.lastActiveProjectId = activeProjectId;
			if (Object.keys(payload).length > 0) {
				api.setGeneralSettings(payload).catch(() => {});
			}
		}, 500);
		return () => clearTimeout(timer);
	}, [activeAgentId, activeProjectId]);

	// Permission ask: 30s default-deny timer.
	useEffect(() => {
		if (!pendingAsk) return;
		const head = pendingAsk;
		const timer = setTimeout(() => {
			const asks = appStore.get(pendingAsksAtom);
			if (asks.length > 0 && asks[0].requestId === head.requestId) {
				appStore.set(pendingAsksAtom, asks.slice(1));
			}
			api.respondPermission({ action: "deny", requestId: head.requestId, reason: "Timed out (30s)" }).catch(
				() => {},
			);
			toast(t("permission.timedOut", { toolName: head.toolName }), { description: head.reason, duration: 3000 });
		}, 30_000);
		return () => clearTimeout(timer);
	}, [pendingAsk, t]);

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

	return (
		<ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
			<TooltipProvider>
				<div className="app-shell flex h-screen overflow-hidden bg-background p-2">
					<Sidebar
						onSelect={handleSelectAgent}
						onDestroy={handleDestroyAgent}
						onCreateClick={handleCreateClick}
						onQuickCreateChat={handleQuickCreateChat}
						onSettingsClick={handleSettingsClick}
						onSelectProject={handleSelectProject}
						onCreateProject={handleOpenProject}
						onDeleteProject={handleDeleteProject}
					/>

					<Separator orientation="vertical" className="mx-2 bg-transparent" />

					<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-background">
						{!api ? null : projects.length === 0 ? (
							<WelcomeScreen onOpenProject={handleOpenProject} />
						) : activeAgent ? (
							<>
								<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-hairline px-4">
									<div className="flex min-w-0 items-center gap-3">
										<PixelAgentAvatar role={activeAgent.role} status={activeAgent.status} size="sm" active />
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
									agentRole={activeAgent.role}
									agentName={activeAgent.name}
									messages={activeMessages}
									autoCollapse={autoCollapse}
									queue={activeQueue}
									agentStatus={activeAgent.status}
									currentModel={activeAgent.model}
									currentThinking={activeAgent.thinkingLevel}
									currentPermissionMode={activeAgent.permissionMode ?? "ask"}
									onSend={handleSendMessage}
									onThinkingChange={handleThinkingChange}
									onModelChange={handleModelChanged}
									onPermissionModeChange={handlePermissionModeChange}
									onRequestApiKeys={handleRequestApiKeys}
									onAbort={handleAbortAgent}
								/>
							</>
						) : (
							<div className="flex flex-1 items-center justify-center p-10 text-center">
								<div className="flex max-w-sm flex-col items-center gap-3">
									<PixelAgentAvatar size="lg" />
									<p className="text-xs text-muted-foreground">Select an agent or create one to begin.</p>
								</div>
							</div>
						)}
					</main>

					{showCreateDialog && (
						<AgentCreateDialog
							defaultModel={defaultModelForCreate}
							onCreate={handleCreateAgent}
							onClose={handleCloseCreateDialog}
						/>
					)}
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

					<PermissionDialog
						request={pendingAsk}
						queueDepth={pendingQueueDepth}
						onAllow={handlePermissionAllow}
						onDeny={handlePermissionDeny}
						onEdit={handlePermissionEdit}
					/>
				</div>
			</TooltipProvider>
		</ThemeProvider>
	);
}
