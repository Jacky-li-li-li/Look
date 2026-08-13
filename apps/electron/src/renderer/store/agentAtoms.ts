import type { AgentInfo } from "@shared/types";
import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { appStore } from "./appStore";
import { registerAgentFamily } from "./atomFamilyRegistry";
import {
	deriveAgentPhase,
	deriveSessionPhase,
	emptyRendererSessionState,
	type RendererSessionPhase,
	type RendererSessionState,
} from "./sessionTypes";

export const agentsAtom = atom<AgentInfo[]>([]);

/**
 * Patch a single agent in agentsAtom, skipping the write when none of the
 * `changedKeys` fields actually differ.
 *
 * Streaming hot paths (session snapshots, run_status batches) project the
 * active agent onto agentsAtom every frame. Jotai notifies every subscriber
 * on any write, so unconditionally mapping to a new array re-renders
 * App/AppLayout/Sidebar/dialogs even when the projected values are identical.
 * Keeping the array reference stable lets memoized consumers bail out.
 *
 * `changedKeys` must list every field the updater may touch — fields outside
 * the list are excluded from the equality check (and must stay unchanged).
 */
export function updateAgent(
	agentId: string,
	changedKeys: readonly (keyof AgentInfo)[],
	updater: (agent: AgentInfo) => AgentInfo,
): void {
	const previous = appStore.get(agentsAtom);
	const index = previous.findIndex((agent) => agent.id === agentId);
	if (index < 0) return;
	const current = previous[index]!;
	const nextAgent = updater(current);
	if (nextAgent === current) return;
	const changed = changedKeys.some((key) => current[key] !== nextAgent[key]);
	if (!changed) return;
	const next = [...previous];
	next[index] = nextAgent;
	appStore.set(agentsAtom, next);
}

/** True while at least one session exists. Derived so AppLayout's memo holds
 *  when agentsAtom churns (selectAtom notifies only when the boolean flips). */
export const hasAgentsAtom = selectAtom(agentsAtom, (agents) => agents.length > 0);

export const activeAgentIdAtom = atom<string | null>(null);

export const recentlyCompletedAtom = atom<string[]>([]);

/** Session-level errors remain visible until the user opens the affected session. */
export const sessionErrorsAtom = atom<Set<string>>(new Set<string>());

export const sessionStateAtomFamily = atomFamily((_agentId: string) =>
	atom<RendererSessionState>(emptyRendererSessionState()),
);
registerAgentFamily(sessionStateAtomFamily);

export const sessionPhasesAtom = atom<Map<string, RendererSessionPhase>>((get) => {
	const phases = new Map<string, RendererSessionPhase>();
	for (const agent of get(agentsAtom)) {
		const statePhase = deriveSessionPhase(get(sessionStateAtomFamily(agent.id)));
		phases.set(agent.id, statePhase === "idle" ? deriveAgentPhase(agent) : statePhase);
	}
	return phases;
});

export const runningAgentsAtom = atom<Set<string>>((get) => {
	const running = new Set<string>();
	for (const [sessionId, phase] of get(sessionPhasesAtom)) {
		if (phase !== "idle") running.add(sessionId);
	}
	return running;
});

export const sessionLeafIdAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));
registerAgentFamily(sessionLeafIdAtomFamily);

export const navigatingEntryAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));
registerAgentFamily(navigatingEntryAtomFamily);

export const forkingEntryAtomFamily = atomFamily((_agentId: string) => atom<string | null>(null));
registerAgentFamily(forkingEntryAtomFamily);

export const subSessionsAtomFamily = atomFamily((parentId: string) =>
	selectAtom(
		agentsAtom,
		(agents) => agents.filter((a) => a.parentSessionId === parentId),
		(a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
	),
);

export const activeAgentAtom = atom((get) => {
	const agents = get(agentsAtom);
	const id = get(activeAgentIdAtom);
	return id ? (agents.find((a) => a.id === id) ?? null) : null;
});
