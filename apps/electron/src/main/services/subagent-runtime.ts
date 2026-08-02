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

// 注意：不再设置子会话执行超时（曾为 5 分钟硬超时）。并行子会话共享
// ModelRuntime/LLM 连接，全项目审查类任务实际耗时可达 4~8 分钟，硬超时
// 会误杀正常执行的子会话；且旧超时结算只 finalize 不 abort，导致被判失败
// 的子会话继续空跑浪费资源、父会话误判后重复重试（见项目级 Context
// subagent-parallel-timeout-2026-08-02.md）。子会话中止现在只由 AbortSignal
// 驱动（父会话中止/用户取消），不再有自动超时兜底。
// 此设计取舍对 single / parallel / chain 三种模式一致：parallel 有
// maxWaitMs 汇报点 + subagent_status/cancel 可主动管理；single/chain 卡死时
// 只能靠用户停止父会话级联中止——这是用户明确拍板的决策，勿擅自加回超时。

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
		toolCallId?: string,
		taskTitle?: string,
	): Promise<SubagentResult> {
		const pending: PendingSubSession = {
			childSessionId,
			parentSessionId,
			agent,
			task,
			displayName: displayName || agent.title || agent.name,
			toolCallId: toolCallId || "",
			taskTitle: taskTitle || "",
			resolve: undefined!,
			onUpdate,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			removeAbortListener: () => {},
			aborted: false,
		};
		this.registry.addPending(pending);

		// 父会话中止 → 中止子会话（无条件 abort：子会话可能不在 streaming，
		// 此时 session.abort() 的 waitForIdle 立即返回，但 agent.abort() 已触发，
		// 下一个 streaming 窗口会生效；不能因 isStreaming 跳过，否则取消永远不生效）
		if (signal) {
			const onAbort = () => {
				pending.aborted = true;
				const runtime = this.host.getRuntime(childSessionId);
				if (runtime?.session) {
					runtime.session.abort().catch((err: unknown) => console.warn("[SubAgentRuntime] abort failed:", err));
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}

		return new Promise<SubagentResult>((resolve) => {
			pending.resolve = (result: SubagentResult) => {
				resolve(result);
			};
		});
	}

	/** 在子会话 agent_end（非 retry）或异常时结算结果并 resolve。 */
	finalizeSubSession(childSessionId: string, forceFailed = false, forceAborted = false): void {
		const pending = this.registry.removePending(childSessionId);
		if (!pending) return;
		pending.removeAbortListener();

		const runtime = this.host.getRuntime(childSessionId);
		const session = runtime?.session;
		const finalOutput = session ? this.getFinalAssistantText(session) : "";
		let status: "completed" | "failed" | "aborted";
		// 状态优先级：中止（signal 触发、调用方强制，或 SDK 中止产生的 stopReason="aborted"）
		// > 失败（预检失败/运行错误）> 正常完成。
		// 注意：直接停止子会话（非父级联）时 pending.aborted 不会被设置，但 SDK 中止后
		// message_end 的 stopReason 为 "aborted"（见 pi-agent-core agent.js handleRunFailure），
		// 必须据此判定 aborted，否则中止会被误报成 completed、chain 模式继续跑下一步。
		if (pending.aborted || forceAborted || pending.stopReason === "aborted") status = "aborted";
		else if (forceFailed || pending.stopReason === "error") status = "failed";
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
			toolCallId: pending.toolCallId,
			taskTitle: pending.taskTitle,
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
		const progress: SubagentProgress = {
			childSessionId: sessionId,
			parentSessionId: pending.parentSessionId,
			agentName: pending.displayName,
			task: pending.task,
			status: "running",
			partialOutput,
			usage: pending.usage,
			model: pending.model,
		};
		// 同步推送给工具层 onUpdate（并行 run 的进度快照/流式更新依赖此调用）
		pending.onUpdate?.(progress);
		this.host.emit({
			type: "session:subagent-progress",
			parentSessionId: pending.parentSessionId,
			childSessionId: sessionId,
			agentName: pending.displayName,
			toolCallId: pending.toolCallId,
			taskTitle: pending.taskTitle,
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
				// 先标记 pending.aborted：子会话 agent_end 到达时 finalizeSubSession
				// 才能报 aborted 而不是 completed。旧实现只调 session.abort() 不标记，
				// 导致停止父会话时子会话被中止却误报 completed，chain 模式继续跑下一步。
				const pending = this.registry.getPending(childId);
				if (pending) pending.aborted = true;
				const child = this.host.getRuntime(childId);
				if (child?.session) {
					await child.session
						.abort()
						.catch((err: unknown) => console.warn("[SubAgentRuntime] abort failed:", err));
				}
			}),
		);
	}

	/**
	 * 在父会话 dispose 时，通过 finalizeSubSession 结算所有 pending 子会话。
	 * 与 abortPendingForParent 不同，此方法走完整的 finalize 路径：
	 * 构建 result、emit session:subagent-completed、调度 cleanup timer。
	 */
	finalizePendingChildren(parentSessionId: string): void {
		const childIds = this.registry.listChildren(parentSessionId);
		for (const childId of childIds) {
			const pending = this.registry.getPending(childId);
			if (pending) {
				pending.aborted = true;
			}
			this.finalizeSubSession(childId, true);
		}
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
