// ============================================================
// SubAgentRuntimeService — extracted sub-session lifecycle logic
//
// Extracted from SessionRuntimeManager to reduce SRT's footprint
// and enable independent testing of sub-session tracking,
// finalization, cleanup, and cascading abort/destroy logic.
//
// Depends on ISubAgentRuntimeHost (5 methods) + SubAgentRegistry.
// ISP: uses getRuntime, getSession, emit, disposeRuntime,
// getStoredSessionPath — not the full IRuntimeLifecycle (11 methods).
// (hasCleanupTimer here is the service's own method, not a host call.)
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { ISubAgentRuntimeHost } from "../core/contracts.js";
import type { AgentConfig, SubagentProgress, SubagentResult } from "../extensions/subagent/types.js";
import type { PendingSubSession, SubAgentRegistry } from "../session/subagent-registry.js";

// ── Constants ──

/** 子会话超时（5 分钟）：若 agent_end 未在此时限内触发，强制结算为 aborted。 */
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** 子会话 runtime 完成后的延迟清理时间（5 分钟）。 */
const SUBAGENT_CLEANUP_DELAY_MS = 5 * 60 * 1000;

// ── Service ──

export class SubAgentRuntimeService {
	/** 已完成子会话的延迟清理定时器（childSessionId → timeout）。 */
	private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly host: ISubAgentRuntimeHost,
		private readonly registry: SubAgentRegistry,
	) {}

	// ── Public API ──

	/** 取子会话最后一条 assistant 消息的文本输出。 */
	getFinalAssistantText(session: AgentSession): string {
		const branch = session.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const textParts: string[] = [];
				for (const part of entry.message.content) {
					if (part.type === "text" && part.text) textParts.push(part.text);
				}
				return textParts.join("\n");
			}
		}
		return "";
	}

	/**
	 * 建立子会话完成跟踪，返回在 agent_end（非 retry）时 resolve 的结果 Promise。
	 */
	setupSubSessionTracking(
		childSessionId: string,
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate: ((progress: SubagentProgress) => void) | undefined,
		displayName?: string,
	): Promise<SubagentResult> {
		const pending: PendingSubSession = {
			childSessionId,
			parentSessionId,
			agent,
			task,
			displayName: displayName || agent.title || agent.name,
			resolve: undefined!,
			onUpdate,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			removeAbortListener: () => {},
			aborted: false,
		};
		this.registry.addPending(pending);

		// 父会话中止 → 中止子会话
		if (signal) {
			const onAbort = () => {
				pending.aborted = true;
				const runtime = this.host.getRuntime(childSessionId);
				if (runtime?.session.isStreaming) {
					runtime.session.abort().catch((err: unknown) => console.warn("[SubAgentRuntime] abort failed:", err));
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}

		const timeout = setTimeout(() => {
			this.finalizeSubSession(childSessionId, true);
		}, SUBAGENT_TIMEOUT_MS);

		return new Promise<SubagentResult>((resolve) => {
			pending.resolve = (result: SubagentResult) => {
				clearTimeout(timeout);
				resolve(result);
			};
		});
	}

	/** 在子会话 agent_end（非 retry）或异常时结算结果并 resolve。 */
	finalizeSubSession(childSessionId: string, forceFailed = false): void {
		const pending = this.registry.removePending(childSessionId);
		if (!pending) return;
		pending.removeAbortListener();

		const runtime = this.host.getRuntime(childSessionId);
		const session = runtime?.session;
		const finalOutput = session ? this.getFinalAssistantText(session) : "";
		let status: "completed" | "failed" | "aborted";
		if (forceFailed || pending.aborted) status = "aborted";
		else if (pending.stopReason === "error") status = "failed";
		else status = "completed";

		const result: SubagentResult = {
			sessionId: childSessionId,
			agentName: pending.displayName,
			agentSource: pending.agent.source,
			task: pending.task,
			status,
			finalOutput: finalOutput || pending.errorMessage || "(no output)",
			usage: pending.usage,
			model: pending.model,
			stopReason: pending.stopReason,
			errorMessage: pending.errorMessage,
		};

		this.host.emit({
			type: "session:subagent-completed",
			parentSessionId: pending.parentSessionId,
			childSessionId,
			agentName: pending.displayName,
			result: {
				sessionId: result.sessionId,
				agentName: result.agentName,
				status,
				finalOutput: result.finalOutput,
				model: result.model,
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
			},
		});
		pending.resolve(result);

		// 调度延迟清理：保留 session JSONL 在磁盘，释放 AgentSessionRuntime 内存。
		this.scheduleSubSessionCleanup(childSessionId);
	}

	/** 子会话 assistant message_end：累计用量、记录模型/停止原因，并向父会话推送进度。 */
	trackSubSessionMessageEnd(sessionId: string, message: AgentMessage): void {
		const pending = this.registry.getPending(sessionId);
		if (!pending) return;
		pending.usage.turns += 1;
		const usage = (
			message as {
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
					totalTokens?: number;
				};
			}
		).usage;
		if (usage) {
			pending.usage.input += usage.input ?? 0;
			pending.usage.output += usage.output ?? 0;
			pending.usage.cacheRead += usage.cacheRead ?? 0;
			pending.usage.cacheWrite += usage.cacheWrite ?? 0;
			pending.usage.cost += usage.cost?.total ?? 0;
			pending.usage.contextTokens += usage.totalTokens ?? 0;
		}
		const model = (message as { model?: string }).model;
		if (model) pending.model = model;
		const stopReason = (message as { stopReason?: string }).stopReason;
		if (stopReason) pending.stopReason = stopReason;

		const childSession = this.host.getSession(sessionId);
		const partialOutput = childSession ? this.getFinalAssistantText(childSession) : "";
		this.host.emit({
			type: "session:subagent-progress",
			parentSessionId: pending.parentSessionId,
			childSessionId: sessionId,
			agentName: pending.displayName,
			status: "running",
			task: pending.task,
			usage: pending.usage,
			model: pending.model,
			partialOutput,
		});
	}

	/** 级联中止子会话（不删除文件，可继续查看历史）。 */
	async abortSubSessions(parentSessionId: string): Promise<void> {
		const childIds = this.registry.listChildren(parentSessionId);
		await Promise.all(
			childIds.map(async (childId) => {
				const child = this.host.getRuntime(childId);
				if (child?.session.isStreaming) {
					await child.session
						.abort()
						.catch((err: unknown) => console.warn("[SubAgentRuntime] abort failed:", err));
				}
			}),
		);
	}

	/** 级联销毁子会话（dispose runtime + 删除 session 文件 + 清理注册表）。 */
	async destroySubSessions(parentSessionId: string): Promise<void> {
		const childIds = this.registry.listChildren(parentSessionId);
		await Promise.all(
			childIds.map(async (childId) => {
				this.cancelSubSessionCleanup(childId);
				const childFile =
					this.host.getRuntime(childId)?.session.sessionFile ?? this.host.getStoredSessionPath(childId);
				await this.host
					.disposeRuntime(childId, true)
					.catch((err: unknown) => console.warn("[SubAgentRuntime] cleanup failed:", err));
				if (childFile) {
					try {
						const fs = await import("node:fs");
						fs.unlinkSync(childFile);
					} catch (error: unknown) {
						const err = error as NodeJS.ErrnoException;
						if (err?.code !== "ENOENT") throw error;
					}
				}
				this.registry.unregister(childId);
				this.host.emit({ type: "agent:destroyed", agentId: childId });
			}),
		);
	}

	// ── Cleanup lifecycle ──

	/** 调度子会话 runtime 延迟清理（保留 session JSONL 文件，释放内存）。 */
	scheduleSubSessionCleanup(childSessionId: string): void {
		this.cancelSubSessionCleanup(childSessionId);
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(childSessionId);
			this.cleanupFinalizedSubSession(childSessionId);
		}, SUBAGENT_CLEANUP_DELAY_MS);
		this.cleanupTimers.set(childSessionId, timer);
	}

	/** 取消子会话的延迟清理定时器（用户重新激活时调用）。 */
	cancelSubSessionCleanup(childSessionId: string): void {
		const timer = this.cleanupTimers.get(childSessionId);
		if (timer) {
			clearTimeout(timer);
			this.cleanupTimers.delete(childSessionId);
		}
	}

	/** 检查是否有待处理的清理定时器。 */
	hasCleanupTimer(childSessionId: string): boolean {
		return this.cleanupTimers.has(childSessionId);
	}

	/**
	 * 清理已完成的子会话 runtime：释放 AgentSessionRuntime 资源，
	 * 保留 session JSONL 文件在磁盘上供后续重新打开。
	 */
	private cleanupFinalizedSubSession(childSessionId: string): void {
		const runtime = this.host.getRuntime(childSessionId);
		if (!runtime) return;
		if (this.registry.hasPending(childSessionId)) return;
		if (runtime.session.isStreaming) return;

		// Use disposeRuntime for full cleanup
		this.host
			.disposeRuntime(childSessionId, false)
			.catch((err: unknown) => console.warn("[SubAgentRuntime] cleanup failed:", err));
		this.registry.unregister(childSessionId);
	}
}
