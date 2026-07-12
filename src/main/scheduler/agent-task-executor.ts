import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ScheduledTask } from "@look/shared/types";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";

export interface ScheduledTaskExecutionContext {
	runId: string;
	attempt: number;
	signal: AbortSignal;
}

export interface ScheduledTaskExecutionResult {
	output: string;
	sessionId?: string;
}

export interface ScheduledTaskExecutor {
	execute(task: ScheduledTask, context: ScheduledTaskExecutionContext): Promise<ScheduledTaskExecutionResult>;
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

export function renderScheduledPrompt(prompt: string, parameters: Record<string, string>): string {
	return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => parameters[key] ?? match);
}

/** Runs a scheduled prompt in an independent, background pi session. */
export class AgentScheduledTaskExecutor implements ScheduledTaskExecutor {
	constructor(private readonly runtimeManager: SessionRuntimeManager) {}

	async execute(task: ScheduledTask, context: ScheduledTaskExecutionContext): Promise<ScheduledTaskExecutionResult> {
		if (context.signal.aborted) throw context.signal.reason ?? new Error("Scheduled task aborted");
		const project = this.runtimeManager.getProjectInfo(task.projectId);
		if (!project) {
			throw new Error(
				`Project not found for scheduled task "${task.name}" (projectId: ${task.projectId}). ` +
					`The project may have been deleted; please edit the task and select a valid project.`,
			);
		}
		if (!project.valid) {
			throw new Error(
				`Project path does not exist for scheduled task "${task.name}": ${project.cwd}. ` +
					`The project folder is missing; please restore it or select a different project.`,
			);
		}
		const sessionId = await this.runtimeManager.createAgent({
			name: `⏱ ${task.name}`,
			projectId: task.projectId,
			background: true,
		});
		try {
			if (task.model) await this.runtimeManager.setModel(sessionId, task.model);
			await this.runtimeManager.setInternalPermissionMode(sessionId, "always");
			const session = this.runtimeManager.getSession(sessionId);
			if (!session) throw new Error(`Scheduled task session ${sessionId} was not initialized`);

			let output = "";
			let terminalError: Error | null = null;
			return await new Promise<ScheduledTaskExecutionResult>((resolve, reject) => {
				let settled = false;
				const cleanup = () => {
					unsubscribe();
					context.signal.removeEventListener("abort", onAbort);
				};
				const finish = (error?: unknown) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error) reject(error);
					else resolve({ output, sessionId });
				};
				const onAbort = () => {
					void this.runtimeManager
						.abortAgent(sessionId)
						.finally(() => finish(context.signal.reason ?? new Error("Scheduled task aborted")));
				};
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "assistant") {
						const text = messageText(event.message);
						if (text) output = text; // 只在有文本内容时更新，避免工具调用消息清空已收集的输出
						const detail = event.message as { stopReason?: string; errorMessage?: string };
						terminalError =
							detail.stopReason === "error" ? new Error(detail.errorMessage || "Agent task failed") : null;
					}
					if (event.type === "agent_end" && !event.willRetry) {
						finish(context.signal.aborted ? context.signal.reason : (terminalError ?? undefined));
					}
					if (event.type === "auto_retry_end" && !event.success) {
						finish(terminalError ?? new Error("Agent retry failed"));
					}
				});

				context.signal.addEventListener("abort", onAbort, { once: true });
				if (context.signal.aborted) {
					onAbort();
					return;
				}
				void this.runtimeManager
					.sendMessage(sessionId, renderScheduledPrompt(task.prompt, task.parameters))
					.catch(finish);
			});
		} finally {
			// 使用 disposeRuntime 而非 destroyAgent：保留 session JSONL 文件在磁盘上，
			// 让用户可以在侧边栏回看定时任务的完整对话记录（含工具调用和思考过程）
			await this.runtimeManager.disposeRuntime(sessionId, true).catch(() => {});
		}
	}
}
