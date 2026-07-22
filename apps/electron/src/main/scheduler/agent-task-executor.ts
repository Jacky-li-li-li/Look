import type { ScheduledTask } from "@look/shared/types";
import {
	HeadlessAgentRunner,
	type ExecutionProfile,
	type HeadlessAgentRunResult,
	type HeadlessRunSource,
} from "../execution/headless-agent-runner.js";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";

export interface ScheduledTaskExecutionContext {
	runId: string;
	attempt: number;
	signal: AbortSignal;
	source?: HeadlessRunSource;
	executionProfile?: ExecutionProfile;
}

export interface ScheduledTaskExecutionResult extends HeadlessAgentRunResult {}

export interface ScheduledTaskExecutor {
	execute(task: ScheduledTask, context: ScheduledTaskExecutionContext): Promise<ScheduledTaskExecutionResult>;
}

export function renderScheduledPrompt(prompt: string, parameters: Record<string, string>): string {
	return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => parameters[key] ?? match);
}

/** Adapts durable scheduler tasks to the shared headless Agent execution boundary. */
export class AgentScheduledTaskExecutor implements ScheduledTaskExecutor {
	private readonly runner: HeadlessAgentRunner;

	constructor(runtimeManager: SessionRuntimeManager) {
		this.runner = new HeadlessAgentRunner(runtimeManager);
	}

	execute(task: ScheduledTask, context: ScheduledTaskExecutionContext): Promise<ScheduledTaskExecutionResult> {
		return this.runner.run({
			source: context.source ?? "scheduled-task",
			executionProfile: context.executionProfile ?? "unattended-scheduled-task",
			projectId: task.projectId,
			name: `⏱ ${task.name}`,
			prompt: renderScheduledPrompt(task.prompt, task.parameters),
			model: task.model,
			signal: context.signal,
		});
	}
}
