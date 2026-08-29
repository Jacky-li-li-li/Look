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

/**
 * 派生结果的引用稳定化缓存：流式期间 sessionStateAtomFamily 每帧换新对象，
 * 这两个派生 atom 每帧重算却产出内容相同的 Map/Set。返回旧引用让 Jotai
 * 跳过订阅者通知，侧栏（ProjectTree）才不会在整个流式期间每帧重渲染。
 * 仅对单例 appStore 安全——模块级缓存跨 store 共享，测试若用独立 store
 * 读取这些 atom 需注意。
 */
let lastSessionPhases: Map<string, RendererSessionPhase> | undefined;
let lastRunningAgents: Set<string> | undefined;

function samePhaseMap(a: Map<string, RendererSessionPhase>, b: Map<string, RendererSessionPhase>): boolean {
	if (a.size !== b.size) return false;
	for (const [id, phase] of a) {
		if (b.get(id) !== phase) return false;
	}
	return true;
}

export const sessionPhasesAtom = atom<Map<string, RendererSessionPhase>>((get) => {
	const phases = new Map<string, RendererSessionPhase>();
	for (const agent of get(agentsAtom)) {
		const statePhase = deriveSessionPhase(get(sessionStateAtomFamily(agent.id)));
		phases.set(agent.id, statePhase === "idle" ? deriveAgentPhase(agent) : statePhase);
	}
	if (lastSessionPhases && samePhaseMap(lastSessionPhases, phases)) return lastSessionPhases;
	lastSessionPhases = phases;
	return phases;
});

export const runningAgentsAtom = atom<Set<string>>((get) => {
	const running = new Set<string>();
	for (const [sessionId, phase] of get(sessionPhasesAtom)) {
		if (phase !== "idle") running.add(sessionId);
	}
	// phase 变化不一定改变 running 集合（thinking→working 两者都非 idle）；
	// 同样返回旧引用避免侧栏无谓重渲染。
	if (lastRunningAgents && lastRunningAgents.size === running.size) {
		let same = true;
		for (const id of running) {
			if (!lastRunningAgents.has(id)) {
				same = false;
				break;
			}
		}
		if (same) return lastRunningAgents;
	}
	lastRunningAgents = running;
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
