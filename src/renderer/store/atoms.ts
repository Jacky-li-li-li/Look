import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { AgentInfo, PiMessage } from "@shared/types";
import type { PermissionRequest } from "../components/PermissionDialog";

// ---- Core data ----

export const agentsAtom = atom<AgentInfo[]>([]);

export const activeAgentIdAtom = atom<string | null>(null);

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
