import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import type { AgentInfo, PiMessage, ProjectInfo } from "@shared/types";
import type { PermissionRequest } from "../components/PermissionDialog";

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
	return new Set(
		agents
			.filter((a) => a.status === "thinking" || a.status === "working")
			.map((a) => a.id),
	);
});

// ---- Project data ----

export const projectsAtom = atom<ProjectInfo[]>([]);

export const activeProjectIdAtom = atom<string | null>(null);

/** Pending delete confirmation: project info + agent count from main process. */
export const pendingDeleteProjectAtom = atom<{
	projectId: string;
	projectName: string;
	agentCount: number;
} | null>(null);

/** Per-agent message history. atomFamily creates one atom per agentId. */
export const messagesAtomFamily = atomFamily((_agentId: string) => atom<PiMessage[]>([]));

/** Per-agent SDK queue snapshot (driven by `agent:queue_update` events). */
export const queuesAtomFamily = atomFamily((_agentId: string) =>
	atom<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }),
);

export const pendingAsksAtom = atom<PermissionRequest[]>([]);

// ---- Settings (persisted via IPC to main process, NOT localStorage) ----

export const autoCollapseAtom = atom(true);

export const userPreferredModelAtom = atom<string | null>(null);

/** Last active agent id for auto-restore on app startup. */
export const lastActiveAgentIdAtom = atom<string | null>(null);

// ---- UI state ----

export const showCreateDialogAtom = atom(false);
export const defaultModelForCreateAtom = atom<string | undefined>(undefined);
export const showSettingsAtom = atom(false);
export const settingsTabAtom = atom<"general" | "api-keys" | "chat-prompt" | "about">("general");

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
	envVar: string;
	modelsAvailable: number;
}
export const providerSettingsAtom = atom<SettingsProviderInfo[]>([]);

// ---- Cleanup: call when an agent is destroyed to free atom memory ----

export function removeAgentAtoms(agentId: string): void {
	messagesAtomFamily.remove(agentId);
	queuesAtomFamily.remove(agentId);
}
