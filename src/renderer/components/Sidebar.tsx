import { Button } from "@shared/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@shared/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { cn } from "@shared/lib/utils";
import type { AgentInfo, ProjectInfo } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import {
	AlertTriangle,
	ChevronRight,
	Copy,
	Download,
	Folder,
	FolderOpen,
	MoreHorizontal,
	PanelLeftClose,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	activeProjectIdAtom,
	agentsAtom,
	openProjectIdsAtom,
	projectsAtom,
	recentlyCompletedAtom,
	runningAgentsAtom,
	sidebarCollapsedAtom,
} from "../store/atoms";
import { userProfileAtom } from "../store/authAtoms";
import { appStore } from "../store/ipcHandler";
import UserAvatar from "./UserAvatar";

const api = (window as any).look;

interface SidebarProps {
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	onCreateClick: (projectId: string) => void;
	onSettingsClick: () => void;
	onCreateProject: () => void;
	onDeleteProject: (project: ProjectInfo) => void;
	onOpenProject: (projectId: string) => void;
	onRenameProject: (projectId: string, name: string) => void;
}

function fmtRelativeTime(ts: number): string {
	const seconds = Math.floor((Date.now() - ts) / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function shortenPath(cwd: string, homedir: string): string {
	return homedir && cwd.startsWith(homedir) ? `~${cwd.slice(homedir.length)}` : cwd;
}

export default function Sidebar({
	onSelect,
	onDestroy,
	onCreateClick,
	onSettingsClick,
	onCreateProject,
	onDeleteProject,
	onOpenProject,
	onRenameProject,
}: SidebarProps) {
	const { t } = useTranslation();
	const agents = useAtomValue(agentsAtom);
	const projects = useAtomValue(projectsAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const recentlyCompleted = useAtomValue(recentlyCompletedAtom);
	const runningAgents = useAtomValue(runningAgentsAtom);
	const activeChatAtBottom = useAtomValue(activeChatAtBottomAtom);
	const userProfile = useAtomValue(userProfileAtom);
	const collapsed = useAtomValue(sidebarCollapsedAtom);
	const homedir = api?.homedir || "";
	const [openProjectIds, setOpenProjectIds] = useAtom(openProjectIdsAtom);
	const openProjects = useMemo(() => new Set(openProjectIds), [openProjectIds]);
	const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const editRef = useRef<HTMLInputElement>(null);

	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, AgentInfo[]>();
		for (const project of projects) grouped.set(project.id, []);
		for (const agent of agents) {
			if (!agent.projectId) continue;
			const list = grouped.get(agent.projectId) ?? [];
			list.push(agent);
			grouped.set(agent.projectId, list);
		}
		for (const sessions of grouped.values()) sessions.sort((a, b) => b.createdAt - a.createdAt);
		return grouped;
	}, [agents, projects]);

	useEffect(() => {
		setOpenProjectIds((previousIds) => {
			const previous = new Set(previousIds);
			const next = new Set(previous);
			if (activeProjectId) next.add(activeProjectId);
			const activeAgent = agents.find((agent) => agent.id === activeAgentId);
			if (activeAgent?.projectId) next.add(activeAgent.projectId);
			for (const agent of agents) {
				if (agent.projectId && runningAgents.has(agent.id)) next.add(agent.projectId);
			}
			if (next.size === 0 && projects[0]) next.add(projects[0].id);
			if (next.size === previous.size && [...next].every((projectId) => previous.has(projectId))) {
				return previousIds;
			}
			return [...next];
		});
	}, [activeAgentId, activeProjectId, agents, projects, runningAgents, setOpenProjectIds]);

	useEffect(() => {
		if (!activeAgentId) return;
		const frame = requestAnimationFrame(() => {
			const element = document.querySelector<HTMLElement>(`[data-agent-id="${activeAgentId}"]`);
			const viewport = element?.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
			if (element && viewport) {
				element.scrollIntoView({ block: "nearest", inline: "nearest" });
				viewport.scrollLeft = 0;
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [activeAgentId]);

	const beginEdit = useCallback((kind: "project" | "session", id: string, value: string) => {
		setEditingProjectId(kind === "project" ? id : null);
		setEditingSessionId(kind === "session" ? id : null);
		setEditValue(value);
		setTimeout(() => editRef.current?.select(), 0);
	}, []);

	const cancelEdit = useCallback(() => {
		setEditingProjectId(null);
		setEditingSessionId(null);
		setEditValue("");
	}, []);

	const commitEdit = useCallback(() => {
		const value = editValue.trim();
		if (value && editingProjectId) onRenameProject(editingProjectId, value);
		if (value && editingSessionId) api?.renameAgent(editingSessionId, value);
		cancelEdit();
	}, [cancelEdit, editValue, editingProjectId, editingSessionId, onRenameProject]);

	const handleEditKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitEdit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				cancelEdit();
			}
		},
		[cancelEdit, commitEdit],
	);

	const selectSession = useCallback(
		(agent: AgentInfo) => {
			if (recentlyCompleted.includes(agent.id)) {
				appStore.set(
					recentlyCompletedAtom,
					recentlyCompleted.filter((id) => id !== agent.id),
				);
			}
			onSelect(agent.id);
		},
		[onSelect, recentlyCompleted],
	);

	const copySessionId = useCallback(
		async (sessionId: string) => {
			try {
				await navigator.clipboard.writeText(sessionId);
				toast.success(t("sidebar.copiedId", "Session ID copied"));
			} catch {
				toast.error(t("sidebar.copyFailed", "Copy failed"));
			}
		},
		[t],
	);

	const exportSession = useCallback(
		async (sessionId: string) => {
			const result = await api?.exportChat?.(sessionId).catch(() => null);
			if (result?.success) toast.success(t("sidebar.exportSuccess", "Session exported"));
			else toast.error(result?.error ?? t("sidebar.exportFailed", "Export failed"));
		},
		[t],
	);

	return (
		<aside
			className="workspace-ledger glass-panel sidebar-wrapper flex h-full shrink-0 flex-col overflow-hidden rounded-xl border"
			data-collapsed={collapsed}
		>
			<header className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-3">
				<div className="min-w-0">
					<div className="text-sm font-bold tracking-[0.2em] text-foreground">LOOK</div>
					<div className="mt-0.5 font-mono text-[9px] text-muted-foreground/55">
						{projects.length.toString().padStart(2, "0")} {t("workspace.projects", "projects")}
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						variant="line-ghost"
						size="icon-sm"
						className="border border-hairline rounded-md"
						onClick={onCreateProject}
						aria-label={t("project.openProject", "Add project folder")}
						title={t("project.openProject", "Add project folder")}
					>
						<FolderOpen className="size-3.5" />
						<Plus className="absolute ml-3 mt-3 size-2.5 rounded-full bg-sidebar" />
					</Button>
					<Button
						variant="line-ghost"
						size="icon-sm"
						className="border border-hairline rounded-md"
						onClick={() => appStore.set(sidebarCollapsedAtom, true)}
						aria-label={t("sidebar.collapse", "Collapse sidebar")}
						title={t("sidebar.collapse", "Collapse sidebar")}
					>
						<PanelLeftClose className="size-3.5" />
					</Button>
				</div>
			</header>

			<ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden" type="always">
				<div className="space-y-1.5 px-2 py-2">
					{projects.map((project) => {
						const sessions = sessionsByProject.get(project.id) ?? [];
						const runningCount = sessions.filter((session) => runningAgents.has(session.id)).length;
						const isOpen = openProjects.has(project.id);
						const isActiveProject = project.id === activeProjectId;
						return (
							<Collapsible
								key={project.id}
								open={isOpen}
								onOpenChange={(open) => {
									setOpenProjectIds((previousIds) => {
										const previous = new Set(previousIds);
										const next = new Set(previous);
										if (open) next.add(project.id);
										else next.delete(project.id);
										return [...next];
									});
								}}
								className="workspace-group"
								data-active={isActiveProject || undefined}
								data-running={runningCount > 0 || undefined}
							>
								<div className="group/project flex h-10 items-center gap-1 rounded-lg px-1 transition-colors hover:bg-foreground/[0.035]">
									<CollapsibleTrigger asChild>
										<button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left">
											<ChevronRight
												className={cn(
													"size-3 shrink-0 text-muted-foreground transition-transform",
													isOpen && "rotate-90",
												)}
											/>
											<span className="workspace-folder-mark">
												{project.valid ? (
													<Folder className="size-3.5" />
												) : (
													<AlertTriangle className="size-3.5" />
												)}
											</span>
											<span className="min-w-0 flex-1">
												{editingProjectId === project.id ? (
													<input
														ref={editRef}
														value={editValue}
														onChange={(event) => setEditValue(event.target.value)}
														onBlur={commitEdit}
														onKeyDown={handleEditKeyDown}
														onClick={(event) => event.stopPropagation()}
														className="w-full border-b border-foreground/40 bg-transparent text-[12px] font-semibold outline-none"
														maxLength={64}
													/>
												) : (
													<span
														className="block truncate text-[12px] font-semibold"
														onDoubleClick={(event) => {
															event.stopPropagation();
															beginEdit("project", project.id, project.name);
														}}
													>
														{project.name}
													</span>
												)}
												<span className="block truncate font-mono text-[9px] leading-tight text-muted-foreground/55">
													{shortenPath(project.cwd, homedir)}
												</span>
											</span>
											{runningCount > 0 ? (
												<span className="workspace-live-count">
													{runningCount.toString().padStart(2, "0")}
												</span>
											) : (
												<span className="font-mono text-[9px] text-muted-foreground/45">
													{sessions.length}
												</span>
											)}
										</button>
									</CollapsibleTrigger>
									<Button
										variant="line-ghost"
										size="icon-xs"
										className="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
										disabled={!project.valid}
										onClick={() => onCreateClick(project.id)}
										aria-label={t("sidebar.newSession", "New session")}
									>
										<Plus className="size-3" />
									</Button>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="line-ghost"
												size="icon-xs"
												className="opacity-0 group-hover/project:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
												aria-label={t("workspace.projectMenu", "Project menu")}
											>
												<MoreHorizontal className="size-3" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="w-44">
											<DropdownMenuItem
												onSelect={() => onOpenProject(project.id)}
												className="gap-2 text-[12px]"
											>
												<FolderOpen className="size-3.5" /> {t("workspace.openFolder", "Open folder")}
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() => beginEdit("project", project.id, project.name)}
												className="gap-2 text-[12px]"
											>
												<Pencil className="size-3.5" /> {t("sidebar.rename", "Rename")}
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onSelect={() => onDeleteProject(project)}
												className="gap-2 text-[12px]"
											>
												<Trash2 className="size-3.5" /> {t("project.delete", "Delete project")}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>

								<CollapsibleContent className="workspace-group-content">
									<div className="workspace-session-rail ml-[18px] space-y-0.5 pb-1 pl-2">
										{!project.valid && (
											<div className="mx-1 my-1 rounded-md border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
												{t("project.pathMissing", "Project folder is unavailable")}
											</div>
										)}
										{sessions.map((agent) => {
											const isActive = agent.id === activeAgentId;
											const isRunning = runningAgents.has(agent.id);
											const isCompleted =
												recentlyCompleted.includes(agent.id) && !(isActive && activeChatAtBottom);
											return (
												<div
													key={agent.id}
													data-agent-id={agent.id}
													data-agent-status={agent.status}
													data-running={isRunning || undefined}
													data-completed={isCompleted ? "" : undefined}
													data-active={isActive || undefined}
													className="session-ledger-row group/session flex h-[38px] items-center gap-2 rounded-md border border-transparent px-2"
												>
													<button
														type="button"
														className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
														onClick={() => selectSession(agent)}
														onDoubleClick={() => beginEdit("session", agent.id, agent.name)}
													>
														<span className="status-mark" data-status={agent.status} />
														<span className="min-w-0 flex-1">
															{editingSessionId === agent.id ? (
																<input
																	ref={editRef}
																	value={editValue}
																	onChange={(event) => setEditValue(event.target.value)}
																	onBlur={commitEdit}
																	onKeyDown={handleEditKeyDown}
																	onClick={(event) => event.stopPropagation()}
																	className="w-full border-b border-foreground/40 bg-transparent text-[11px] font-medium outline-none"
																/>
															) : (
																<span className="block truncate text-[11px] font-medium">
																	{agent.name}
																</span>
															)}
															<span className="block truncate font-mono text-[8.5px] leading-tight text-muted-foreground/50">
																{isRunning
																	? t(`session.status.${agent.status}`, agent.status)
																	: agent.model ||
																		(agent.sessionFilePath
																			? t("session.messageCount", {
																					count: agent.messageCount,
																					defaultValue: "{{count}} messages",
																				})
																			: t("session.draft", "draft"))}
															</span>
														</span>
														<span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">
															{fmtRelativeTime(agent.createdAt)}
														</span>
													</button>
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button
																variant="line-ghost"
																size="icon-xs"
																className="-mr-1 opacity-0 group-hover/session:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
																aria-label={t("session.menu", "Session menu")}
															>
																<MoreHorizontal className="size-3" />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end" className="w-44">
															<DropdownMenuItem
																onSelect={() => beginEdit("session", agent.id, agent.name)}
																className="gap-2 text-[12px]"
															>
																<Pencil className="size-3.5" /> {t("sidebar.rename", "Rename")}
															</DropdownMenuItem>
															<DropdownMenuItem
																onSelect={() => copySessionId(agent.id)}
																className="gap-2 text-[12px]"
															>
																<Copy className="size-3.5" /> {t("sidebar.copyId", "Copy session ID")}
															</DropdownMenuItem>
															<DropdownMenuItem
																onSelect={() => exportSession(agent.id)}
																className="gap-2 text-[12px]"
															>
																<Download className="size-3.5" />{" "}
																{t("sidebar.exportChat", "Export session")}
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																variant="destructive"
																onSelect={() => onDestroy(agent.id)}
																className="gap-2 text-[12px]"
															>
																<Trash2 className="size-3.5" /> {t("sidebar.delete", "Delete")}
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</div>
											);
										})}

										{sessions.length === 0 && project.valid && (
											<button
												type="button"
												onClick={() => onCreateClick(project.id)}
												className="workspace-empty-session flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[10px] text-muted-foreground"
											>
												<Plus className="size-3" />{" "}
												{t("workspace.createFirstSession", "Create first session")}
											</button>
										)}
									</div>
								</CollapsibleContent>
							</Collapsible>
						);
					})}

					{projects.length === 0 && (
						<button
							type="button"
							onClick={onCreateProject}
							className="workspace-zero-state w-full rounded-lg border border-dashed p-5 text-center"
						>
							<FolderOpen className="mx-auto size-5 text-muted-foreground" />
							<span className="mt-2 block text-[11px] font-medium">
								{t("workspace.addFirstProject", "Add a project folder")}
							</span>
							<span className="mt-1 block text-[9px] text-muted-foreground">
								{t("workspace.addFirstProjectHint", "Sessions stay scoped to its cwd")}
							</span>
						</button>
					)}
				</div>
			</ScrollArea>

			<button
				type="button"
				onClick={onSettingsClick}
				className="flex h-11 shrink-0 items-center gap-2 border-t border-hairline px-3 text-left transition-colors hover:bg-foreground/[0.035]"
			>
				<UserAvatar avatar={userProfile.avatar} size="sm" />
				<span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
					{userProfile.userName || "You"}
				</span>
				<span className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground/45">
					{t("sidebar.settings", "Settings")}
				</span>
			</button>
		</aside>
	);
}
