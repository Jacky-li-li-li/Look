import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PermissionMode } from "@look/shared/types";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";

export type HeadlessRunSource = "scheduled-task" | "manual-task-run" | "manual-task-test";
export type ExecutionProfile = "unattended-scheduled-task" | "interactive-test";

export interface HeadlessAgentRunInput {
	source: HeadlessRunSource;
	executionProfile: ExecutionProfile;
	projectId: string;
	name: string;
	prompt: string;
	model?: string;
	signal: AbortSignal;
}

export interface HeadlessAgentRunResult {
	output: string;
	sessionId: string;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? [text] : [];
		})
		.join("\n")
		.trim();
}

function permissionModeFor(profile: ExecutionProfile): PermissionMode {
	return profile === "unattended-scheduled-task" ? "always" : "ask";
}

/** Runs an independent pi session while preserving its JSONL history for later inspection. */
export class HeadlessAgentRunner {
	constructor(private readonly runtimeManager: SessionRuntimeManager) {}

	async run(input: HeadlessAgentRunInput): Promise<HeadlessAgentRunResult> {
		if (input.signal.aborted) throw input.signal.reason ?? new Error("Headless agent run aborted");
		const project = this.runtimeManager.getProjectInfo(input.projectId);
		if (!project) throw new Error(`Project not found for ${input.source}: ${input.projectId}`);
		if (!project.valid) throw new Error(`Project path does not exist for ${input.source}: ${project.cwd}`);

		const sessionId = await this.runtimeManager.createAgent({
			name: input.name,
			projectId: input.projectId,
			background: true,
		});
		try {
			if (input.model) await this.runtimeManager.setModel(sessionId, input.model);
			await this.runtimeManager.setInternalPermissionMode(sessionId, permissionModeFor(input.executionProfile));
			const session = this.runtimeManager.getSession(sessionId);
			if (!session) throw new Error(`Headless session ${sessionId} was not initialized`);

			let output = "";
			let terminalError: Error | null = null;
			return await new Promise<HeadlessAgentRunResult>((resolve, reject) => {
				let settled = false;
				const cleanup = () => {
					unsubscribe();
					input.signal.removeEventListener("abort", onAbort);
				};
				const finish = (error?: unknown) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error) reject(error);
					else resolve({ output, sessionId });
				};
				const onAbort = () => {
					void this.runtimeManager.abortAgent(sessionId).finally(() => {
						finish(input.signal.reason ?? new Error("Headless agent run aborted"));
					});
				};
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "assistant") {
						const text = messageText(event.message);
						if (text) output = text;
						const detail = event.message as { stopReason?: string; errorMessage?: string };
						terminalError =
							detail.stopReason === "error" ? new Error(detail.errorMessage || "Agent task failed") : null;
					}
					if (event.type === "agent_end" && !event.willRetry) {
						finish(input.signal.aborted ? input.signal.reason : (terminalError ?? undefined));
					}
					if (event.type === "auto_retry_end" && !event.success)
						finish(terminalError ?? new Error("Agent retry failed"));
				});

				input.signal.addEventListener("abort", onAbort, { once: true });
				if (input.signal.aborted) onAbort();
				else void this.runtimeManager.sendMessage(sessionId, input.prompt).catch(finish);
			});
		} finally {
			await this.runtimeManager.disposeRuntime(sessionId, true).catch((error) => {
				console.warn("[HeadlessAgentRunner] disposeRuntime failed:", error);
			});
		}
	}
}
