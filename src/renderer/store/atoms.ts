import type { AgentInfo, PiMessage, ProjectInfo, SessionTreeNode } from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

// ---- Core data ----

export const agentsAtom = atom<AgentInfo[]>([]);

export const activeAgentIdAtom = atom<string | null>(null);

/**
 * Tracks which agents have just completed a session successfully.
 * Used by Sidebar to show a green border indicator.
 * Cleared when user clicks/selects the agent.
 */
export const recentlyCompletedAtom = atom<string[]>([]);

/** Derived: set of currently running agent IDs (thinking/working) */
export const runningAgentsAtom = atom<Set<string>>((get) => {
	const agents = get(agentsAtom);
	return new Set(agents.filter((a) => a.status === "thinking" || a.status === "working").map((a) => a.id));
});

// ---- Project data ----

export const projectsAtom = atom<ProjectInfo[]>([]);

export const activeProjectIdAtom = atom<string | null>(null);

/** Expanded project groups in the compact workspace ledger. */
export const openProjectIdsAtom = atom<string[]>([]);

/** Pending delete confirmation: project info + agent count from main process. */
export const pendingDeleteProjectAtom = atom<{
	projectId: string;
	projectName: string;
	agentCount: number;
	runningCount: number;
} | null>(null);

/** Per-agent message history. atomFamily creates one atom per agentId. */
export const messagesAtomFamily = atomFamily((_agentId: string) => atom<PiMessage[]>([]));

/** Per-agent SDK queue snapshot (driven by `agent:queue_update` events). */
export const queuesAtomFamily = atomFamily((_agentId: string) =>
	atom<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }),
);

// ---- v0.4 Session tree / branching ----

/** Per-agent session tree (single-root, IPC-friendly shape). Driven
 *  by `agent:tree-changed` events emitted from the main process when
 *  the leaf moves (append / navigate / label). Read by the future
 *  tree-view UI and by ChatPanel to know whether the current view is
 *  on the "latest" branch. */
export const sessionTreeAtomFamily = atomFamily((_agentId: string) => atom<SessionTreeNode | null>(null));

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
export const providerSettingsAtom = atom<SettingsProviderInfo[]>([]);

// ---- Cleanup: call when an agent is destroyed to free atom memory ----

export function removeAgentAtoms(agentId: string): void {
	messagesAtomFamily.remove(agentId);
	queuesAtomFamily.remove(agentId);
	// v0.4: free the per-agent tree/leaf/navigating/forking atoms too
	// so a re-created agent with the same id (extremely unlikely, but
	// possible after a uuidv4 collision) doesn't inherit stale state.
	sessionTreeAtomFamily.remove(agentId);
	sessionLeafIdAtomFamily.remove(agentId);
	navigatingEntryAtomFamily.remove(agentId);
	forkingEntryAtomFamily.remove(agentId);
}
