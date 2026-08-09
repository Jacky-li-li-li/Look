// ============================================================
// Sidebar/ProjectTree — 项目+会话树渲染
// ============================================================

import { Collapsible, CollapsibleContent } from "@look/ui/components/ui/collapsible";
import { type AgentInfo, DEFAULT_PROJECT_ID, type ProjectInfo } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import { ChevronsDownUp, ChevronsUpDown, FolderOpen, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { appStore } from "../../store/appStore";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	activeProjectIdAtom,
	agentsAtom,
	openProjectIdsAtom,
	projectsAtom,
	recentlyCompletedAtom,
	runningAgentsAtom,
	sessionErrorsAtom,
	sessionPhasesAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
	showSettingsAtom,
} from "../../store/atoms";
import ProjectHeader from "./ProjectHeader";
import SessionRow from "./SessionRow";
import type { ChildSessionInfo, ProjectTreeProps } from "./types";
import { getSessionActivityAt, SESSION_COLLAPSE_THRESHOLD, sortSessionsByActivity } from "./utils";

/** 稳定空数组引用，避免每次渲染创建新引用导致 memo 失效 */
const EMPTY_CHILDREN: ChildSessionInfo[] = [];

const api = window.look;

export default function ProjectTree({
	onSelect,
	onDestroy,
	onCreateClick,
	onCreateProject,
	onSelectProject,
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
	const errorAgentIds = useAtomValue(sessionErrorsAtom);
	const runningAgents = useAtomValue(runningAgentsAtom);
	const sessionPhases = useAtomValue(sessionPhasesAtom);
	const activeChatAtBottom = useAtomValue(activeChatAtBottomAtom);

	// Keep compact relative timestamps fresh without subscribing every row to its own timer.
	const [, setRelativeTimeTick] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setRelativeTimeTick(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);

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

	// 子会话折叠状态：parentId → 是否折叠（未记录默认展开）。
	// 旧版本（<1.6）存的是折叠白名单数组 ["id1","id2"]，此处做格式迁移。
	// 注意：创建子会话时应默认展开，让用户立即可见新子会话——
	// 见下方 useNewSubsessionAutoExpand effect。
	const LS_KEY = "look-collapsed-subsessions";
	const [collapsedSubSessions, setCollapsedSubSessions] = useState<Record<string, boolean>>(() => {
		try {
			const raw = localStorage.getItem(LS_KEY);
			if (!raw) return {};
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				// 旧格式：白名单数组 → 折叠 map（数组中的 id 折叠）
				const map: Record<string, boolean> = {};
				for (const id of parsed) {
					if (typeof id === "string") map[id] = true;
				}
				return map;
			}
			if (parsed && typeof parsed === "object") {
				return parsed as Record<string, boolean>;
			}
			return {};
		} catch {
			return {};
		}
	});

	// 持久化：副作用移出 setState updater，避免 React 并发渲染/strict mode 下
	// updater 被重复调用或丢弃导致 localStorage 写入竞态（旧值覆盖新值）。
	useEffect(() => {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify(collapsedSubSessions));
		} catch {
			/* noop */
		}
	}, [collapsedSubSessions]);

	const toggleSubSessions = useCallback((parentId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		setCollapsedSubSessions((prev) => {
			const isCollapsed = prev[parentId] ?? false; // 未记录默认展开
			return { ...prev, [parentId]: !isCollapsed };
		});
	}, []);

	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, AgentInfo[]>();
		for (const project of projects) grouped.set(project.id, []);
		for (const agent of agents) {
			if (!agent.projectId) continue;
			const list = grouped.get(agent.projectId) ?? [];
			list.push(agent);
			grouped.set(agent.projectId, list);
		}
		for (const [projectId, sessions] of grouped) grouped.set(projectId, sortSessionsByActivity(sessions));
		return grouped;
	}, [agents, projects]);

	const sortedProjects = useMemo(() => {
		const projectActivity = (projectId: string): number =>
			(sessionsByProject.get(projectId) ?? []).reduce(
				(latest, session) => Math.max(latest, getSessionActivityAt(session)),
				0,
			);
		const projectIsRunning = (projectId: string): boolean =>
			(sessionsByProject.get(projectId) ?? []).some((session) => runningAgents.has(session.id));
		const projectHasError = (projectId: string): boolean =>
			(sessionsByProject.get(projectId) ?? []).some((session) => errorAgentIds.has(session.id));

		return [...projects].sort((a, b) => {
			if (a.id === DEFAULT_PROJECT_ID) return -1;
			if (b.id === DEFAULT_PROJECT_ID) return 1;
			if (a.id === activeProjectId) return -1;
			if (b.id === activeProjectId) return 1;
			const runningDelta = Number(projectIsRunning(b.id)) - Number(projectIsRunning(a.id));
			if (runningDelta) return runningDelta;
			const errorDelta = Number(projectHasError(b.id)) - Number(projectHasError(a.id));
			if (errorDelta) return errorDelta;
			return projectActivity(b.id) - projectActivity(a.id) || b.createdAt - a.createdAt;
		});
	}, [activeProjectId, errorAgentIds, projects, runningAgents, sessionsByProject]);

	const childSessionsByParent = useMemo(() => {
		const map = new Map<string, AgentInfo[]>();
		for (const agent of agents) {
			if (agent.parentSessionId) {
				const list = map.get(agent.parentSessionId) ?? [];
				list.push(agent);
				map.set(agent.parentSessionId, list);
			}
		}
		for (const children of map.values()) children.sort((a, b) => getSessionActivityAt(b) - getSessionActivityAt(a));
		return map;
	}, [agents]);

	// 新子会话自动展开：检测到 parent 新增了 child（或 child 集合变大）时，
	// 即使该父会话之前被用户手动折叠过，也自动展开一次，确保创建子会话后
	// 侧栏立即可见。只对“新增”触发，不覆盖用户后续的手动折叠。
	const prevChildCountRef = useRef<Map<string, number>>(new Map());
	useEffect(() => {
		const prevCounts = prevChildCountRef.current;
		const changedParents: string[] = [];
		for (const [parentId, children] of childSessionsByParent) {
			const prevCount = prevCounts.get(parentId) ?? 0;
			if (children.length > prevCount) changedParents.push(parentId);
		}
		if (changedParents.length > 0) {
			setCollapsedSubSessions((prev) => {
				const next = { ...prev };
				let changed = false;
				for (const parentId of changedParents) {
					if (next[parentId] !== false) {
						next[parentId] = false;
						changed = true;
					}
				}
				return changed ? next : prev;
			});
		}
		const nextCounts = new Map<string, number>();
		for (const [parentId, children] of childSessionsByParent) nextCounts.set(parentId, children.length);
		prevChildCountRef.current = nextCounts;
	}, [childSessionsByParent]);

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
			if (errorAgentIds.has(agent.id)) {
				appStore.set(sessionErrorsAtom, (previous: Set<string>) => {
					const next = new Set(previous);
					next.delete(agent.id);
					return next;
				});
			}
			appStore.set(showAgentSquareAtom, false);
			appStore.set(showScheduledTasksAtom, false);
			appStore.set(showSettingsAtom, false);
			onSelect(agent.id);
		},
		[errorAgentIds, onSelect, recentlyCompleted],
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

	const selectProject = useCallback(
		async (projectId: string) => {
			appStore.set(showAgentSquareAtom, false);
			appStore.set(showScheduledTasksAtom, false);
			appStore.set(showSettingsAtom, false);
			await onSelectProject(projectId);
		},
		[onSelectProject],
	);

	const allProjectsOpen = sortedProjects.length > 0 && sortedProjects.every((project) => openProjects.has(project.id));
	const toggleAllProjects = useCallback(() => {
		setOpenProjectIds(allProjectsOpen ? [] : sortedProjects.map((project) => project.id));
	}, [allProjectsOpen, setOpenProjectIds, sortedProjects]);

	if (projects.length === 0) {
		return (
			<div className="sidebar-empty-state flex flex-col items-center gap-2 px-4 py-10 text-center">
				<FolderOpen className="size-5 text-muted-foreground/55" />
				<p className="text-[12px] font-medium text-foreground/80">{t("workspace.noProjects", "No projects yet")}</p>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					{t("workspace.noProjectsHint", "Add a project folder to start a scoped session.")}
				</p>
				<button
					type="button"
					className="workspace-empty-session mt-1 flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] font-medium"
					onClick={onCreateProject}
				>
					<Plus className="size-3" />
					{t("project.openProject", "Add project folder")}
				</button>
			</div>
		);
	}

	return (
		<>
			<div className="workspace-tree-toolbar flex h-7 items-center justify-between px-1" role="toolbar">
				<span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
					{t("workspace.title", "Workspaces")}
				</span>
				<button
					type="button"
					className="sidebar-icon-action inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:text-foreground focus-visible:text-foreground"
					onClick={toggleAllProjects}
					aria-label={
						allProjectsOpen
							? t("workspace.collapseAllProjects", "Collapse all projects")
							: t("workspace.expandAllProjects", "Expand all projects")
					}
					title={
						allProjectsOpen
							? t("workspace.collapseAllProjects", "Collapse all projects")
							: t("workspace.expandAllProjects", "Expand all projects")
					}
				>
					{allProjectsOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
				</button>
			</div>
			<div role="tree" aria-label={t("sidebar.projectsLabel", "Projects and sessions")}>
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
						errorAgentIds={errorAgentIds}
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
						selectProject={selectProject}
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
			</div>
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
	errorAgentIds: Set<string>;
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
	selectProject: (projectId: string) => void;
	collapsedSubSessions: Record<string, boolean>;
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
	errorAgentIds,
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
	selectProject,
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
	const recentlyCompletedIds = new Set(recentlyCompleted);
	const prioritySessionIds = new Set<string>();
	for (const session of sessions) {
		const needsAttention =
			session.id === activeAgentId ||
			runningAgents.has(session.id) ||
			recentlyCompletedIds.has(session.id) ||
			errorAgentIds.has(session.id);
		if (needsAttention) prioritySessionIds.add(session.parentSessionId ?? session.id);
	}
	const sortedTopLevel = [...topLevelSessions].sort((a, b) => b.createdAt - a.createdAt);
	const prioritySessions = sortedTopLevel.filter((session) => prioritySessionIds.has(session.id));
	// 折叠时保持 createdAt 顺序：priority 会话（当前/运行中/刚完成/错误）只保证“不被隐藏”，
	// 不改变相对位置——否则点击会话使其成为 active 后会跳到列表顶部（2026-08-09 修复）。
	const visibleSessions = isExpanded
		? sortedTopLevel
		: (() => {
				const regularBudget = Math.max(0, SESSION_COLLAPSE_THRESHOLD - prioritySessions.length);
				let regularShown = 0;
				return sortedTopLevel.filter((session) => {
					if (prioritySessionIds.has(session.id)) return true;
					if (regularShown < regularBudget) {
						regularShown += 1;
						return true;
					}
					return false;
				});
			})();
	const hiddenCount = Math.max(0, topLevelSessions.length - visibleSessions.length);
	const hasOverflow = topLevelSessions.length > SESSION_COLLAPSE_THRESHOLD;
	const shouldCollapse = !isExpanded && hiddenCount > 0;
	const runningCount = sessions.filter((session) => runningAgents.has(session.id)).length;
	const hasError = sessions.some((session) => errorAgentIds.has(session.id));

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
			role="treeitem"
			aria-expanded={isOpen}
			aria-selected={isActiveProject || undefined}
			data-active={isActiveProject || undefined}
			data-running={runningCount > 0 || undefined}
		>
			<ProjectHeader
				project={project}
				isOpen={isOpen}
				isActive={isActiveProject}
				runningCount={runningCount}
				hasError={hasError}
				sessionCount={topLevelSessions.length}
				onSelectProject={selectProject}
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
						<div className="mx-1 my-1 rounded-md border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
							{t("project.pathMissing", "Project folder is unavailable")}
						</div>
					)}
					{visibleSessions.map((agent) => {
						const isActive = agent.id === activeAgentId;
						const isRunning = runningAgents.has(agent.id);
						const isError = errorAgentIds.has(agent.id);
						const phase = sessionPhases.get(agent.id) ?? "idle";
						const isCompleted = recentlyCompleted.includes(agent.id) && !(isActive && activeChatAtBottom);
						// 预计算子会话的 phase/running，消除 SessionRow 对全局 atom 的订阅
						const rawChildren = childSessionsByParent.get(agent.id);
						const childrenList = rawChildren
							? rawChildren.map((child) => ({
									agent: child,
									childPhase: sessionPhases.get(child.id) ?? "idle",
									childRunning: runningAgents.has(child.id),
									childError: errorAgentIds.has(child.id),
									childActive: child.id === activeAgentId,
									childCompleted:
										recentlyCompleted.includes(child.id) &&
										!(child.id === activeAgentId && activeChatAtBottom),
								}))
							: EMPTY_CHILDREN;
						return (
							<SessionRow
								key={agent.id}
								agent={agent}
								isActive={isActive}
								isRunning={isRunning}
								isError={isError}
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
							className="workspace-toggle-sessions flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11.5px] font-medium text-muted-foreground/70"
						>
							<ChevronsUpDown className="size-3" />
							{t("workspace.expandMore", {
								count: hiddenCount,
								defaultValue: "展开更多 ({{count}})",
							})}
						</button>
					)}

					{hasOverflow && isExpanded && (
						<button
							type="button"
							onClick={() => toggleProjectExpansion(project.id)}
							aria-expanded={isExpanded}
							className="workspace-toggle-sessions flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11.5px] font-medium text-muted-foreground/70"
						>
							<ChevronsDownUp className="size-3" />
							{t("workspace.collapseSessions", "收起")}
						</button>
					)}

					{sessions.length === 0 && project.valid && (
						<button
							type="button"
							onClick={() => onCreateClick(project.id)}
							className="workspace-empty-session flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[11.5px] text-muted-foreground"
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
