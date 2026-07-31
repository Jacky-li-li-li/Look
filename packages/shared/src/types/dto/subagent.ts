/** SubAgent progress event payload (parent session aware of child session, Stage 5). */
export interface SubagentProgressEvent {
	parentSessionId: string;
	childSessionId: string;
	agentName: string;
	toolCallId: string;
	taskTitle: string;
	task: string;
	status: "running" | "completed" | "failed" | "aborted";
	partialOutput: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	model?: string;
}

/** SubAgent completion event payload. */
export interface SubagentCompletedEvent {
	parentSessionId: string;
	childSessionId: string;
	agentName: string;
	toolCallId: string;
	taskTitle: string;
	result: {
		sessionId: string;
		agentName: string;
		status: "completed" | "failed" | "aborted";
		finalOutput: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	};
}
