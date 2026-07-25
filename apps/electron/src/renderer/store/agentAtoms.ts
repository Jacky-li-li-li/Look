import type { AgentInfo } from "@shared/types";
import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { registerAgentFamily } from "./atomFamilyRegistry";
import {
	deriveAgentPhase,
	deriveSessionPhase,
	emptyRendererSessionState,
	type RendererSessionPhase,
	type RendererSessionState,
} from "./sessionTypes";

export const agentsAtom = atom<AgentInfo[]>([]);

export const activeAgentIdAtom = atom<string | null>(null);

export const recentlyCompletedAtom = atom<string[]>([]);

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
