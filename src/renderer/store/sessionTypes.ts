import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentInfo, SessionRuntimeSnapshot } from "@shared/types";

export interface RendererLiveMessage {
	renderId: string;
	runId: number;
	message: AgentMessage;
	completed: boolean;
}

export interface RendererToolExecutionState {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	phase: "running" | "completed";
}

export interface RendererSessionState {
	entries: SessionEntry[];
	liveMessages: RendererLiveMessage[];
	toolExecutions: Record<string, RendererToolExecutionState>;
	runtime: SessionRuntimeSnapshot | null;
	leafId: string | null;
	currentRunId: number;
	currentMessageRenderId: string | null;
	/** Run ID that most recently emitted `agent_end`; used to clean up its live messages. */
	lastEndedRunId: number | null;
	turnStartedAt: number;
	turnDurationMs: number | null;
	/** Per-entry finalized turn durations. Keyed by SessionEntry.id for persisted assistant messages. */
	messageDurations: Record<string, number>;
}

export const emptyRendererSessionState = (): RendererSessionState => ({
	entries: [],
	liveMessages: [],
	toolExecutions: {},
	runtime: null,
	leafId: null,
	currentRunId: 0,
	currentMessageRenderId: null,
	lastEndedRunId: null,
	turnStartedAt: 0,
	turnDurationMs: null,
	messageDurations: {},
});

export type RendererSessionPhase = "idle" | "thinking" | "working" | "retrying" | "compacting";

export function deriveSessionPhase(state: RendererSessionState | null | undefined): RendererSessionPhase {
	if (state?.runtime?.isCompacting) return "compacting";
	if (state?.runtime?.isRetrying) return "retrying";
	if (Object.values(state?.toolExecutions ?? {}).some((tool) => tool.phase === "running")) return "working";
	if (state?.runtime?.isStreaming) return "thinking";
	return "idle";
}

export function deriveAgentPhase(agent: AgentInfo | null | undefined): RendererSessionPhase {
	if (agent?.isCompacting) return "compacting";
	if (agent?.isRetrying) return "retrying";
	if (agent?.isStreaming) return "thinking";
	return "idle";
}
