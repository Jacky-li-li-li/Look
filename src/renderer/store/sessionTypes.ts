import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	AgentInfo,
	LookUiPhase,
	LookUiStreamBlock,
	LookUiToolExecState,
	SessionRuntimeSnapshot,
} from "@shared/types";

export interface RendererSessionState {
	entries: SessionEntry[];
	leafId: string | null;
	/** Non-streaming runtime metadata (model, thinkingLevel, stats, contextUsage). */
	runtime: SessionRuntimeSnapshot | null;
	/** Per-entry finalized turn durations. Keyed by SessionEntry.id for persisted assistant messages. */
	messageDurations: Record<string, number>;

	/** Discrete-event path: live content blocks from session:ui-event. */
	uiBlocks: LookUiStreamBlock[];
	/** Discrete-event path: tool execution states from session:ui-event. */
	uiTools: Record<string, LookUiToolExecState>;
	/** Discrete-event path: canonical phase derived from LookUiEvent. */
	uiPhase: LookUiPhase;
	/** Discrete-event path: steering queue. */
	uiSteering: string[];
	/** Discrete-event path: followUp queue. */
	uiFollowUp: string[];
	/** Pending user message from `user_message` UI event, before the snapshot arrives. */
	pendingUserMessage: { text: string } | null;
}

export const emptyRendererSessionState = (): RendererSessionState => ({
	entries: [],
	leafId: null,
	runtime: null,
	messageDurations: {},
	uiBlocks: [],
	uiTools: {},
	uiPhase: "idle",
	uiSteering: [],
	uiFollowUp: [],
	pendingUserMessage: null,
});

export type RendererSessionPhase = "idle" | "thinking" | "working" | "retrying" | "compacting";

export function deriveSessionPhase(state: RendererSessionState | null | undefined): RendererSessionPhase {
	const uiPhase = state?.uiPhase;

	// A streaming turn with active tool executions is "working".
	if (uiPhase === "streaming") {
		const hasRunningTool = Object.values(state?.uiTools ?? {}).some((tool) => tool.phase === "running");
		if (hasRunningTool) return "working";
		return "thinking";
	}

	// Direct mappings for other discrete-event phases.
	if (uiPhase === "working" || uiPhase === "retrying" || uiPhase === "compacting") {
		return uiPhase;
	}

	// Snapshot race fallback: if uiPhase is idle but the snapshot runtime still reports
	// an active state, trust the runtime until the next UI event arrives.
	if (state?.runtime?.isCompacting) return "compacting";
	if (state?.runtime?.isRetrying) return "retrying";
	if (Object.values(state?.uiTools ?? {}).some((tool) => tool.phase === "running")) return "working";
	if (state?.runtime?.isStreaming) return "thinking";

	return "idle";
}

export function deriveAgentPhase(agent: AgentInfo | null | undefined): RendererSessionPhase {
	if (agent?.isCompacting) return "compacting";
	if (agent?.isRetrying) return "retrying";
	if (agent?.isStreaming) return "thinking";
	return "idle";
}
