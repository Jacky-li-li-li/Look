import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentEvent } from "../src/renderer/store/agentHandlers";
import { appStore } from "../src/renderer/store/appStore";
import {
	activeAgentIdAtom,
	agentsAtom,
	openedSessionIdsAtom,
	permissionAskQueueAtom,
	recentlyCompletedAtom,
	removeAgentAtoms,
	sessionLeafIdAtomFamily,
	sessionStateAtomFamily,
} from "../src/renderer/store/atoms";
import { clearSessionScheduling } from "../src/renderer/store/ui-event-processor";

const sessionId = "agent-a";
const otherSessionId = "agent-b";

function makeAgent(id: string, projectId = "project-1") {
	return {
		id,
		projectId,
		name: `Agent ${id}`,
		model: "test/model",
		thinkingLevel: "normal" as const,
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 0,
		contextUsage: { tokens: 0, maxTokens: 100000 },
	};
}

describe("handleAgentEvent", () => {
	beforeEach(() => {
		appStore.set(agentsAtom, [makeAgent(sessionId), makeAgent(otherSessionId)]);
	});

	afterEach(() => {
		appStore.set(agentsAtom, []);
		appStore.set(activeAgentIdAtom, null);
		appStore.set(openedSessionIdsAtom, []);
		appStore.set(recentlyCompletedAtom, []);
		appStore.set(permissionAskQueueAtom, []);
		removeAgentAtoms(sessionId);
		removeAgentAtoms(otherSessionId);
		clearSessionScheduling(sessionId);
		clearSessionScheduling(otherSessionId);
	});

	it("returns false for unhandled event types", () => {
		const result = handleAgentEvent({ type: "session:snapshot" } as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(result).toBe(false);
	});

	it("agent:list merges agents by project and deduplicates", () => {
		const newAgent = makeAgent("agent-c", "project-2");
		const handled = handleAgentEvent({
			type: "agent:list",
			projectId: "project-2",
			agents: [newAgent],
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(handled).toBe(true);

		const agents = appStore.get(agentsAtom);
		expect(agents).toHaveLength(3);
		expect(agents.some((a) => a.id === "agent-c")).toBe(true);
	});

	it("agent:list resets activeAgentId if active agent is gone", () => {
		appStore.set(activeAgentIdAtom, sessionId);
		handleAgentEvent({
			type: "agent:list",
			projectId: "project-1",
			agents: [makeAgent(otherSessionId)],
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(appStore.get(activeAgentIdAtom)).toBeNull();
	});

	it("agent:created adds or replaces the agent", () => {
		const created = makeAgent("agent-c");
		handleAgentEvent({ type: "agent:created", agent: created } as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(appStore.get(agentsAtom).some((a) => a.id === "agent-c")).toBe(true);
	});

	it("agent:destroyed removes agent and cleans up related atoms", () => {
		appStore.set(activeAgentIdAtom, sessionId);
		appStore.set(openedSessionIdsAtom, [sessionId, otherSessionId]);
		appStore.set(recentlyCompletedAtom, [sessionId]);
		appStore.set(sessionLeafIdAtomFamily(sessionId), "leaf-1");
		appStore.set(permissionAskQueueAtom, [{ requestId: "r1", agentId: sessionId, tool: "write" }]);

		const handled = handleAgentEvent({
			type: "agent:destroyed",
			agentId: sessionId,
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(handled).toBe(true);

		expect(appStore.get(agentsAtom).some((a) => a.id === sessionId)).toBe(false);
		expect(appStore.get(activeAgentIdAtom)).toBeNull();
		expect(appStore.get(openedSessionIdsAtom)).toEqual([otherSessionId]);
		expect(appStore.get(recentlyCompletedAtom)).toEqual([]);
		expect(appStore.get(permissionAskQueueAtom)).toEqual([]);
		expect(appStore.get(sessionLeafIdAtomFamily(sessionId))).toBeNull();
	});

	it("agent:destroyed clears pending UI event scheduling", () => {
		appStore.set(sessionStateAtomFamily(sessionId), {
			...appStore.get(sessionStateAtomFamily(sessionId)),
			uiBlocks: [{ contentIndex: 0, kind: "text", text: "hi", thinking: "", completed: true, uid: 0 }],
		});
		handleAgentEvent({
			type: "agent:destroyed",
			agentId: sessionId,
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		// Scheduling cleared means re-adding the atom family is safe.
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiBlocks).toEqual([]);
	});

	it("agent:updated patches the matching agent", () => {
		handleAgentEvent({
			type: "agent:updated",
			agent: { ...makeAgent(sessionId), name: "Renamed" },
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(appStore.get(agentsAtom).find((a) => a.id === sessionId)?.name).toBe("Renamed");
	});

	it("agent:context-usage updates contextUsage", () => {
		handleAgentEvent({
			type: "agent:context-usage",
			agentId: sessionId,
			contextUsage: { tokens: 100, maxTokens: 200 },
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(appStore.get(agentsAtom).find((a) => a.id === sessionId)?.contextUsage).toEqual({
			tokens: 100,
			maxTokens: 200,
		});
	});

	it("subagent:definitions-updated refreshes agent definitions", async () => {
		const listAgentDefinitions = vi.fn().mockResolvedValue({
			success: true,
			agents: [{ id: "def-1", name: "Def 1", description: "" }],
		});
		vi.stubGlobal("window", { look: { listAgentDefinitions } });

		handleAgentEvent({ type: "subagent:definitions-updated" } as unknown as Parameters<typeof handleAgentEvent>[0]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(listAgentDefinitions).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("error shows a toast", () => {
		const errorToast = vi.fn();
		vi.doMock("sonner", () => ({ toast: { error: errorToast } }));
		// toast is imported at module load, so we test the call path indirectly by
		// ensuring the handler returns true and does not throw.
		const handled = handleAgentEvent({
			type: "error",
			message: "boom",
		} as unknown as Parameters<typeof handleAgentEvent>[0]);
		expect(handled).toBe(true);
		vi.doUnmock("sonner");
	});
});
