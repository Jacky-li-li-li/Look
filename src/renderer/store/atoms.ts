import type {
	AgentInfo,
	FileTreeNode,
	PermissionAskQueueItem,
	PermissionMode,
	PlanApprovalRequest,
	PlanQuestionRequest,
	ProjectInfo,
} from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import {
	deriveAgentPhase,
	deriveSessionPhase,
	emptyRendererSessionState,
	type RendererSessionPhase,
	type RendererSessionState,
} from "./sessionTypes";

// ---- Core data ----

export const agentsAtom = atom<AgentInfo[]>([]);

export const activeAgentIdAtom = atom<string | null>(null);

/**
 * Tracks which agents have just completed a session successfully.
 * Used by Sidebar to show a green border indicator.
 * Cleared when user clicks/selects the agent.
 */
export const recentlyCompletedAtom = atom<string[]>([]);

// ---- Project data ----

export const projectsAtom = atom<ProjectInfo[]>([]);

export const activeProjectIdAtom = atom<string | null>(null);

/** Expanded project groups in the compact workspace ledger. */
export const openProjectIdsAtom = atom<string[]>([]);

/** Session IDs opened as sheets in the top bar. */
export const openedSessionIdsAtom = atom<string[]>([]);

/**
 * Session IDs in activation order (most recent first). Independent of
 * {@link openedSessionIdsAtom} so that clicking a tab does not reorder
 * the visible tab bar — clicking only flips the active highlight. Used
 * by the close-fallback to pick the previous session when the active
 * one is closed.
 */
export const recentlyActiveSessionIdsAtom = atom<string[]>([]);

/** Pending delete confirmation: project info + agent count from main process. */
export const pendingDeleteProjectAtom = atom<{
	projectId: string;
	projectName: string;
	agentCount: number;
	runningCount: number;
} | null>(null);

/** SDK-native persisted/live state, isolated by pi session ID. */
export const sessionStateAtomFamily = atomFamily((_agentId: string) =>
	atom<RendererSessionState>(emptyRendererSessionState()),
);

/** Renderer-only phase derived from native runtime getters and temporary tool executions. */
export const sessionPhasesAtom = atom<Map<string, RendererSessionPhase>>((get) => {
	const phases = new Map<string, RendererSessionPhase>();
	for (const agent of get(agentsAtom)) {
		const statePhase = deriveSessionPhase(get(sessionStateAtomFamily(agent.id)));
		phases.set(agent.id, statePhase === "idle" ? deriveAgentPhase(agent) : statePhase);
	}
	return phases;
});

/** Derived: set of currently running session IDs. */
export const runningAgentsAtom = atom<Set<string>>((get) => {
	const running = new Set<string>();
	for (const [sessionId, phase] of get(sessionPhasesAtom)) {
		if (phase !== "idle") running.add(sessionId);
	}
	return running;
});

// ---- v0.4 Session tree / branching ----

/** Per-agent session tree (single-root, IPC-friendly shape). Driven
 *  by `agent:tree-changed` events emitted from the main process when
 *  the leaf moves (append / navigate / label). Read by the future
 *  tree-view UI and by ChatPanel to know whether the current view is
 *  on the "latest" branch. */
/** Per-agent current leafId. Same source as the tree — `agent:tree-changed`. */
export const sessionLeafIdAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));

/** In-flight navigate calls (per agent). `null` = idle. The renderer
 *  sets it on click and clears it after the IPC resolves; MessageBubble
 *  reads it to disable the action buttons. The non-null value is the
 *  entryId of the target — purely for debugging / future visual feedback,
 *  not a UI flag. */
export const navigatingEntryAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));

/** In-flight createFork calls (per agent). Same shape as above. */
export const forkingEntryAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));

// ---- Settings (persisted via IPC to main process, NOT localStorage) ----

export const autoCollapseAtom = atom(true);

export const userPreferredModelAtom = atom<string | null>(null);

/** SubAgent 功能总开关。关闭后所有会话的 subagent 工具对 LLM 不可见（Stage 2）。 */
export const subagentEnabledAtom = atom(true);

// ---- SubAgent 侧边栏嵌套（Stage 4） ----

/** 按父会话 ID 获取子会话列表（派生自 agentsAtom） */
export const subSessionsAtomFamily = atomFamily((parentId: string) =>
	atom((get) => {
		const allAgents = get(agentsAtom);
		return allAgents.filter((a) => a.parentSessionId === parentId);
	}),
);

// ---- SubAgent 进度卡片（Stage 5） ----

/** 子会话进度项（来自 session:subagent-progress / session:subagent-completed 事件） */
export interface SubagentProgressEntry {
	childSessionId: string;
	agentName: string;
	status: "running" | "completed" | "failed" | "aborted";
	partialOutput?: string;
	finalOutput?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input: number; output: number; cost: number; turns: number };
}

/** 按父会话 ID 追踪的子会话进度列表 */
export const subagentProgressAtomFamily = atomFamily((_parentSessionId: string) => atom<SubagentProgressEntry[]>([]));

// ---- Permission management ----

export const permissionModeAtomFamily = atomFamily((_agentId: string) => atom<PermissionMode>("ask"));

export const permissionAskQueueAtom = atom<PermissionAskQueueItem[]>([]);

export const planQuestionRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanQuestionRequest | null>(null));

export interface PlanQuestionDraft {
	requestId: string | null;
	selections: Record<string, string[]>;
	otherEnabled: Record<string, boolean>;
	otherValues: Record<string, string>;
}

export const emptyPlanQuestionDraft = (): PlanQuestionDraft => ({
	requestId: null,
	selections: {},
	otherEnabled: {},
	otherValues: {},
});

export const planQuestionDraftAtomFamily = atomFamily((_agentId: string) =>
	atom<PlanQuestionDraft>(emptyPlanQuestionDraft()),
);

export const planApprovalRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanApprovalRequest | null>(null));

/**
 * Whether the active agent's chat panel is scrolled to the bottom.
 * Set by ChatPanel (via useStickToBottomContext), read by Sidebar to
 * decide whether to show the completed green border — if the user is
 * already viewing the latest messages, the indicator is unnecessary.
 */
export const activeChatAtBottomAtom = atom(true);

// ---- UI state ----

export const showSettingsAtom = atom(false);
export const settingsTabAtom = atom<"general" | "api-keys" | "about" | "profile">("general");
export const sidebarCollapsedAtom = atom(false);

/** Agent 广场是否占据主区域（替代聊天面板） */
export const showAgentSquareAtom = atom(false);

// ---- v0.5 Shared area ----

/** Right panel collapsed state. */
export const rightPanelCollapsedAtom = atom(false);

/** Right panel active tab. */
export const rightPanelTabAtom = atom<"shared" | "workspace">("workspace");

/** Whether to show hidden files in the workspace tree panel. */
export const showHiddenFilesAtom = atom(false);

/** Per-project 已展开的 workspace 路径集合。 */
export const expandedWorkspacePathsAtomFamily = atomFamily((projectId: string) => atom<Set<string>>(new Set<string>()));

/** Per-project 已加载的子项缓存:parentRelativePath → FileTreeNode[]。 */
export const loadedWorkspaceChildrenAtomFamily = atomFamily((projectId: string) =>
	atom<Map<string, FileTreeNode[]>>(new Map<string, FileTreeNode[]>()),
);

/** Per-project selected node path in the shared area. Per-project keeps
 *  selection from leaking across project switches. */
export const selectedSharedPathAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

/** Per-project shared area file tree. */
export const sharedFilesAtomFamily = atomFamily((projectId: string) => atom<FileTreeNode[]>([]));

/** Per-project shared area loading state. */
export const sharedFilesLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

/** Per-project workspace tree loading state. */
export const workspaceTreeLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

/** Per-project workspace tree error state. null = no error. */
export const workspaceTreeErrorAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

// ---- Auto Updater ----

export interface UpdateStatus {
	stage: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
	version?: string;
	percent?: number;
	message?: string;
}

export const updateStatusAtom = atom<UpdateStatus | null>(null);

// ---- Derived atoms (replace App.tsx useMemo) ----

/** Currently active agent object — derived from agents list + activeAgentId. */
export const activeAgentAtom = atom((get) => {
	const agents = get(agentsAtom);
	const id = get(activeAgentIdAtom);
	return id ? (agents.find((a) => a.id === id) ?? null) : null;
});

/** Currently active project object — derived from projects list + activeProjectId. */
export const activeProjectAtom = atom((get) => {
	const projects = get(projectsAtom);
	const id = get(activeProjectIdAtom);
	return id ? (projects.find((p) => p.id === id) ?? null) : null;
});

// ---- Provider settings cache (fetched once at boot) ----

interface SettingsProviderInfo {
	id: string;
	name: string;
	hasKey: boolean;
	envVar?: string;
	modelsAvailable: number;
	models?: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
	}>;
	authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	envLabel?: string;
}

export interface CustomProviderStats {
	configured: number;
	totalModels: number;
}

export interface ProviderSettingsData {
	providers: SettingsProviderInfo[];
	customStats: CustomProviderStats;
}

export const providerSettingsAtom = atom<ProviderSettingsData>({
	providers: [],
	customStats: { configured: 0, totalModels: 0 },
});

// ---- Cleanup: call when an agent is destroyed to free atom memory ----

export function removeAgentAtoms(agentId: string): void {
	sessionStateAtomFamily.remove(agentId);
	// v0.4: free the per-agent tree/leaf/navigating/forking atoms too
	// so a re-created agent with the same id (extremely unlikely, but
	// possible after a uuidv4 collision) doesn't inherit stale state.
	sessionLeafIdAtomFamily.remove(agentId);
	navigatingEntryAtomFamily.remove(agentId);
	forkingEntryAtomFamily.remove(agentId);
	permissionModeAtomFamily.remove(agentId);
	planQuestionRequestAtomFamily.remove(agentId);
	planQuestionDraftAtomFamily.remove(agentId);
	planApprovalRequestAtomFamily.remove(agentId);
}

/**
 * Cleanup: call when a project is deleted to free per-project atom memory.
 *
 * Why per-project (and not per-agent): shared-area + workspace-tree state is
 * keyed by projectId in the store (sharedFilesAtomFamily, expandedWorkspacePathsAtomFamily,
 * loadedWorkspaceChildrenAtomFamily, selectedSharedPathAtomFamily, sharedFilesLoadingAtomFamily).
 * Without explicit cleanup, deleting a project leaves these atoms resident
 * forever — and the selectedSharedPathAtom in particular would still hold a
 * path string for a project that no longer exists in projectsAtom.
 *
 * Must be called from the IPC handler that processes `project:list` (or the
 * delete-confirmed event) so the cleanup is in lock-step with the new project list.
 */
export function removeProjectAtoms(projectId: string): void {
	expandedWorkspacePathsAtomFamily.remove(projectId);
	loadedWorkspaceChildrenAtomFamily.remove(projectId);
	selectedSharedPathAtomFamily.remove(projectId);
	sharedFilesAtomFamily.remove(projectId);
	sharedFilesLoadingAtomFamily.remove(projectId);
	workspaceTreeLoadingAtomFamily.remove(projectId);
	workspaceTreeErrorAtomFamily.remove(projectId);
}
