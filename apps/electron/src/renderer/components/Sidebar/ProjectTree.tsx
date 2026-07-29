// ============================================================
// Sidebar/ProjectTree — 项目+会话树渲染
// ============================================================

import { Collapsible, CollapsibleContent } from "@look/ui/components/ui/collapsible";
import { type AgentInfo, DEFAULT_PROJECT_ID, type ProjectInfo } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	sessionPhasesAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
} from "../../store/atoms";
import { appStore } from "../../store/ipcHandler";
import ProjectHeader from "./ProjectHeader";
import SessionRow from "./SessionRow";
import type { ChildSessionInfo, ProjectTreeProps } from "./types";
import { SESSION_COLLAPSE_THRESHOLD } from "./utils";

/** 稳定空数组引用，避免每次渲染创建新引用导致 memo 失效 */
const EMPTY_CHILDREN: ChildSessionInfo[] = [];

const api = window.look;

export default function ProjectTree({
	onSelect,
	onDestroy,
	onCreateClick,
	onDeleteProject,
	onOpenProject,
	onRenameProject,
}: ProjectTreeProps) {
	const { t } = useTranslation();
	const agents = useAtomValue(agentsAtom);
	const projects = useAtomValue(projectsAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const recentlyCompleted = useAtomValue(recentlyCompletedAtom);
	const runningAgents = useAtomValue(runningAgentsAtom);
	const sessionPhases = useAtomValue(sessionPhasesAtom);
	const activeChatAtBottom = useAtomValue(activeChatAtBottomAtom);

	const [openProjectIds, setOpenProjectIds] = useAtom(openProjectIdsAtom);
	const openProjects = useMemo(() => new Set(openProjectIds), [openProjectIds]);

	const [edit, setEdit] = useState<{ projectId: string | null; sessionId: string | null; value: string }>({
		projectId: null,
		sessionId: null,
		value: "",
	});
	const editingProjectId = edit.projectId;
	const editingSessionId = edit.sessionId;
	const editValue = edit.value;
	const setEditValue = useCallback((value: string) => setEdit((prev) => ({ ...prev, value })), []);
	const editRef = useRef<HTMLInputElement>(null);

	const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
	const toggleProjectExpansion = useCallback((projectId: string) => {
		setExpandedProjectIds((previous) => {
			const next = new Set(previous);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);

	// 子会话折叠
	const LS_KEY = "look-collapsed-subsessions";
	const [collapsedSubSessions, setCollapsedSubSessions] = useState<Set<string>>(() => {
		try {
			const raw = localStorage.getItem(LS_KEY);
			return raw ? new Set<string>(JSON.parse(raw)) : new Set();
		} catch {
			return new Set();
		}
	});

	const toggleSubSessions = useCallback((parentId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		setCollapsedSubSessions((prev) => {
			const next = new Set(prev);
			if (next.has(parentId)) next.delete(parentId);
			else next.add(parentId);
			try {
				localStorage.setItem(LS_KEY, JSON.stringify([...next]));
			} catch {
				/* noop */
			}
			return next;
		});
	}, []);

	const sortedProjects = useMemo(() => {
		return [...projects].sort((a, b) => {
			if (a.id === DEFAULT_PROJECT_ID) return -1;
			if (b.id === DEFAULT_PROJECT_ID) return 1;
			return 0;
		});
	}, [projects]);

	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, AgentInfo[]>();
		for (const project of sortedProjects) grouped.set(project.id, []);
		for (const agent of agents) {
			if (!agent.projectId) continue;
			const list = grouped.get(agent.projectId) ?? [];
			list.push(agent);
			grouped.set(agent.projectId, list);
		}
		for (const sessions of grouped.values()) sessions.sort((a, b) => b.createdAt - a.createdAt);
		return grouped;
	}, [agents, sortedProjects]);

	const childSessionsByParent = useMemo(() => {
		const map = new Map<string, AgentInfo[]>();
		for (const agent of agents) {
			if (agent.parentSessionId) {
				const list = map.get(agent.parentSessionId) ?? [];
				list.push(agent);
				map.set(agent.parentSessionId, list);
			}
		}
		return map;
	}, [agents]);

	// Auto-expand active project
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

	// Scroll to active session
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

	// Edit handlers
	const beginEdit = useCallback((kind: "project" | "session", id: string, value: string) => {
		setEdit({ projectId: kind === "project" ? id : null, sessionId: kind === "session" ? id : null, value });
		requestAnimationFrame(() => {
			editRef.current?.focus();
			editRef.current?.select();
		});
	}, []);

	const cancelEdit = useCallback(() => {
		setEdit({ projectId: null, sessionId: null, value: "" });
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
				event.stopPropagation();
				event.nativeEvent.stopImmediatePropagation();
				commitEdit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				event.nativeEvent.stopImmediatePropagation();
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
			appStore.set(showAgentSquareAtom, false);
			appStore.set(showScheduledTasksAtom, false);
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

	if (projects.length === 0) return null;

	return (
		<>
			{sortedProjects.map((project) => (
				<ProjectTreeItem
					key={project.id}
					project={project}
					sessions={sessionsByProject.get(project.id) ?? []}
					isOpen={openProjects.has(project.id)}
					isActiveProject={project.id === activeProjectId}
					activeAgentId={activeAgentId}
					runningAgents={runningAgents}
					sessionPhases={sessionPhases}
					recentlyCompleted={recentlyCompleted}
					activeChatAtBottom={activeChatAtBottom}
					childSessionsByParent={childSessionsByParent}
					editingProjectId={editingProjectId}
					editingSessionId={editingSessionId}
					editValue={editValue}
					editRef={editRef}
					setEditValue={setEditValue}
					commitEdit={commitEdit}
					handleEditKeyDown={handleEditKeyDown}
					beginEdit={beginEdit}
					selectSession={selectSession}
					collapsedSubSessions={collapsedSubSessions}
					toggleSubSessions={toggleSubSessions}
					copySessionId={copySessionId}
					onDestroy={onDestroy}
					onCreateClick={onCreateClick}
					onOpenProject={onOpenProject}
					onDeleteProject={onDeleteProject}
					setOpenProjectIds={setOpenProjectIds}
					expandedProjectIds={expandedProjectIds}
					toggleProjectExpansion={toggleProjectExpansion}
				/>
			))}
		</>
	);
}

interface ProjectTreeItemProps {
	project: ProjectInfo;
	sessions: AgentInfo[];
	isOpen: boolean;
	isActiveProject: boolean;
	activeAgentId: string | null;
	runningAgents: Set<string>;
	sessionPhases: Map<string, string>;
	recentlyCompleted: string[];
	activeChatAtBottom: boolean;
	childSessionsByParent: Map<string, AgentInfo[]>;
	editingProjectId: string | null;
	editingSessionId: string | null;
	editValue: string;
	editRef: React.RefObject<HTMLInputElement | null>;
	setEditValue: (value: string) => void;
	commitEdit: () => void;
	handleEditKeyDown: (event: React.KeyboardEvent) => void;
	beginEdit: (kind: "project" | "session", id: string, value: string) => void;
	selectSession: (agent: AgentInfo) => void;
	collapsedSubSessions: Set<string>;
	toggleSubSessions: (parentId: string, event: React.MouseEvent) => void;
	copySessionId: (sessionId: string) => Promise<void>;
	onDestroy: (sessionId: string) => void;
	onCreateClick: (projectId: string) => void;
	onOpenProject: (projectId: string) => void;
	onDeleteProject: (project: ProjectInfo) => void;
	setOpenProjectIds: (update: React.SetStateAction<string[]>) => void;
	expandedProjectIds: Set<string>;
	toggleProjectExpansion: (projectId: string) => void;
}

const ProjectTreeItem = memo(function ProjectTreeItem({
	project,
	sessions,
	isOpen,
	isActiveProject,
	activeAgentId,
	runningAgents,
	sessionPhases,
	recentlyCompleted,
	activeChatAtBottom,
	childSessionsByParent,
	editingProjectId,
	editingSessionId,
	editValue,
	editRef,
	setEditValue,
	commitEdit,
	handleEditKeyDown,
	beginEdit,
	selectSession,
	collapsedSubSessions,
	toggleSubSessions,
	copySessionId,
	onDestroy,
	onCreateClick,
	onOpenProject,
	onDeleteProject,
	setOpenProjectIds,
	expandedProjectIds,
	toggleProjectExpansion,
}: ProjectTreeItemProps) {
	const { t } = useTranslation();
	const topLevelSessions = sessions.filter((s) => !s.parentSessionId);
	const isExpanded = expandedProjectIds.has(project.id);
	const shouldCollapse = topLevelSessions.length > SESSION_COLLAPSE_THRESHOLD && !isExpanded;
	const visibleSessions = shouldCollapse ? topLevelSessions.slice(0, SESSION_COLLAPSE_THRESHOLD) : topLevelSessions;
	const hiddenCount = topLevelSessions.length - SESSION_COLLAPSE_THRESHOLD;
	const runningCount = sessions.filter((session) => runningAgents.has(session.id)).length;

	return (
		<Collapsible
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
			<ProjectHeader
				project={project}
				isOpen={isOpen}
				editingProjectId={editingProjectId}
				editRef={editRef}
				editValue={editValue}
				setEditValue={setEditValue}
				commitEdit={commitEdit}
				handleEditKeyDown={handleEditKeyDown}
				beginEdit={beginEdit}
				onCreateClick={onCreateClick}
				onOpenProject={onOpenProject}
				onDeleteProject={onDeleteProject}
			/>

			<CollapsibleContent className="workspace-group-content">
				<div className="workspace-session-rail ml-[18px] space-y-0.5 pb-1 pl-2">
					{!project.valid && (
						<div className="mx-1 my-1 rounded-md border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
							{t("project.pathMissing", "Project folder is unavailable")}
						</div>
					)}
					{visibleSessions.map((agent) => {
						const isActive = agent.id === activeAgentId;
						const isRunning = runningAgents.has(agent.id);
						const phase = sessionPhases.get(agent.id) ?? "idle";
						const isCompleted = recentlyCompleted.includes(agent.id) && !(isActive && activeChatAtBottom);
						// 预计算子会话的 phase/running，消除 SessionRow 对全局 atom 的订阅
						const rawChildren = childSessionsByParent.get(agent.id);
						const childrenList = rawChildren
							? rawChildren.map((child) => ({
									agent: child,
									childPhase: sessionPhases.get(child.id) ?? "idle",
									childRunning: runningAgents.has(child.id),
									childActive: child.id === activeAgentId,
								}))
							: EMPTY_CHILDREN;
						return (
							<SessionRow
								key={agent.id}
								agent={agent}
								isActive={isActive}
								isRunning={isRunning}
								phase={phase}
								isCompleted={isCompleted}
								editingSessionId={editingSessionId}
								editRef={editRef}
								editValue={editValue}
								setEditValue={setEditValue}
								commitEdit={commitEdit}
								handleEditKeyDown={handleEditKeyDown}
								beginEdit={beginEdit}
								selectSession={selectSession}
								collapsedSubSessions={collapsedSubSessions}
								toggleSubSessions={toggleSubSessions}
								childrenList={childrenList}
								copySessionId={copySessionId}
								onDestroy={onDestroy}
							/>
						);
					})}

					{shouldCollapse && (
						<button
							type="button"
							onClick={() => toggleProjectExpansion(project.id)}
							aria-expanded={isExpanded}
							className="workspace-toggle-sessions flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[10px] font-medium text-muted-foreground/70"
						>
							<ChevronsUpDown className="size-3" />
							{t("workspace.expandMore", {
								count: hiddenCount,
								defaultValue: "展开更多 ({{count}})",
							})}
						</button>
					)}

					{!shouldCollapse && hiddenCount > 0 && (
						<button
							type="button"
							onClick={() => toggleProjectExpansion(project.id)}
							aria-expanded={isExpanded}
							className="workspace-toggle-sessions flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[10px] font-medium text-muted-foreground/70"
						>
							<ChevronsDownUp className="size-3" />
							{t("workspace.collapseSessions", "收起")}
						</button>
					)}

					{sessions.length === 0 && project.valid && (
						<button
							type="button"
							onClick={() => onCreateClick(project.id)}
							className="workspace-empty-session flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[10px] text-muted-foreground"
						>
							<Plus className="size-3" /> {t("workspace.createFirstSession", "Create first session")}
						</button>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
});
ProjectTreeItem.displayName = "ProjectTreeItem";
