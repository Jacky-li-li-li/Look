// ============================================================
// SubAgentService — sub-agent session lifecycle & tracking
//
// Manages the registry of child sessions created by sub-agents,
// their lifecycle tracking (PendingSubSession promises), and the
// per-session enable/disable toggle.
//
// runSubSession (which creates the actual pi sessions) stays in
// SessionRuntimeManager because it needs access to
// createManagedRuntime / SessionManager.create.
//
// Extracted from SessionRuntimeManager (Phase C refactor).
// ============================================================

import fs from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConfig, SubagentProgress, SubagentResult, SubagentUsage } from "../extensions/subagent/types.js";
import type { IEventBus, IRuntimeStore } from "../core/contracts.js";
import type { AgentInfo, MainToRendererEvent } from "../shared/types.js";

// ── Constants ──

/** 子会话 JSONL 中记录父会话链接的自定义条目类型。 */
export const SUBAGENT_PARENT_ENTRY_TYPE = "look.subagent-parent.v1";

// ── Internal types ──

/** 进行中的子会话执行跟踪。resolve 在子会话 agent_end（非 retry）时被调用。 */
interface PendingSubSession {
	childSessionId: string;
	parentSessionId: string;
	agent: AgentConfig;
	task: string;
	displayName: string;
	resolve: (result: SubagentResult) => void;
	onUpdate?: (progress: SubagentProgress) => void;
	usage: SubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	removeAbortListener: () => void;
	aborted: boolean;
}

export interface SubsessionScanMeta {
	sessionId: string;
	displayName?: string;
	parentSessionId?: string;
	agentName?: string;
	firstMessage?: string;
	messageCount: number;
	created: number;
}

// ── Service ──

export class SubAgentService {
	/** 父会话 ID → 子会话 ID 集合 */
	private readonly subSessionRegistry = new Map<string, Set<string>>();
	/** 子会话 ID → 父子关系元数据 */
	private readonly subSessionMeta = new Map<string, { parentSessionId: string; agentName: string }>();
	/** 进行中的子会话执行跟踪 */
	private readonly pendingSubSessions = new Map<string, PendingSubSession>();
	/** Agent 开关：sessionId → enabled */
	private readonly subagentEnabledBySession = new Map<string, boolean>();

	/** SubAgent 全局默认开关（新会话继承） */
	private subagentDefaultEnabled = true;

	constructor(
		private readonly eventBus: IEventBus,
		private readonly runtimeStore: IRuntimeStore,
		private readonly maxNameLength: number,
		initialDefaultEnabled: boolean,
	) {
		this.subagentDefaultEnabled = initialDefaultEnabled;
	}

	// ── Session info display ──

	/** 返回子会话标识字段；非子会话返回空对象（展开后无影响）。 */
	subagentFields(sessionId: string): { parentSessionId?: string; isSubagentSession?: boolean; agentConfigName?: string } {
		const meta = this.subSessionMeta.get(sessionId);
		if (!meta) return {};
		return {
			parentSessionId: meta.parentSessionId,
			isSubagentSession: true,
			agentConfigName: meta.agentName,
		};
	}

	// ── Registry ──

	registerSubSession(parentSessionId: string, childSessionId: string, agentName: string): void {
		let set = this.subSessionRegistry.get(parentSessionId);
		if (!set) {
			set = new Set();
			this.subSessionRegistry.set(parentSessionId, set);
		}
		set.add(childSessionId);
		this.subSessionMeta.set(childSessionId, { parentSessionId, agentName });
	}

	unregisterSubSession(childSessionId: string): void {
		const meta = this.subSessionMeta.get(childSessionId);
		if (meta) {
			const set = this.subSessionRegistry.get(meta.parentSessionId);
			set?.delete(childSessionId);
			if (set && set.size === 0) this.subSessionRegistry.delete(meta.parentSessionId);
		}
		this.subSessionMeta.delete(childSessionId);
		this.pendingSubSessions.delete(childSessionId);
	}

	listSubSessions(parentSessionId: string): string[] {
		return Array.from(this.subSessionRegistry.get(parentSessionId) ?? []);
	}

	getParentSession(childSessionId: string): string | null {
		return this.subSessionMeta.get(childSessionId)?.parentSessionId ?? null;
	}

	// ── Lifecycle tracking ──

	/** 建立子会话完成跟踪，返回在 agent_end（非 retry）时 resolve 的结果 Promise。 */
	setupTracking(
		childSessionId: string,
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		displayName: string,
		signal: AbortSignal | undefined,
		onUpdate?: (progress: SubagentProgress) => void,
	): Promise<SubagentResult> {
		const pending: PendingSubSession = {
			childSessionId,
			parentSessionId,
			agent,
			task,
			displayName,
			resolve: undefined!,
			onUpdate,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			removeAbortListener: () => {},
			aborted: false,
		};
		this.pendingSubSessions.set(childSessionId, pending);

		if (signal) {
			const onAbort = () => {
				pending.aborted = true;
				const managed = this.runtimeStore.getRuntime(childSessionId);
				if (managed?.session.isStreaming) {
					managed.session.abort().catch(() => undefined);
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}

		return new Promise<SubagentResult>((resolve) => {
			pending.resolve = resolve;
		});
	}

	/** 在子会话 agent_end（非 retry）或异常时结算结果并 resolve。 */
	finalizeSubSession(childSessionId: string, forceFailed = false): void {
		const pending = this.pendingSubSessions.get(childSessionId);
		if (!pending) return;
		this.pendingSubSessions.delete(childSessionId);
		pending.removeAbortListener();

		const session = this.runtimeStore.getSession(childSessionId);
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

		this.eventBus.emit({
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
	}

	/** 子会话 assistant message_end：累计用量、记录模型/停止原因，并向父会话推送进度。 */
	trackMessageEnd(sessionId: string, message: AgentMessage): void {
		const pending = this.pendingSubSessions.get(sessionId);
		if (!pending) return;
		pending.usage.turns += 1;
		const usage = (message as any).usage;
		if (usage) {
			pending.usage.input += usage.input ?? 0;
			pending.usage.output += usage.output ?? 0;
			pending.usage.cacheRead += usage.cacheRead ?? 0;
			pending.usage.cacheWrite += usage.cacheWrite ?? 0;
			pending.usage.cost += usage.cost?.total ?? 0;
			pending.usage.contextTokens = usage.totalTokens ?? pending.usage.contextTokens;
		}
		if ((message as any).model) pending.model = (message as any).model;
		if ((message as any).stopReason) pending.stopReason = (message as any).stopReason;
		if ((message as any).errorMessage) pending.errorMessage = (message as any).errorMessage;

		const childSession = this.runtimeStore.getSession(sessionId);
		const partialOutput = childSession ? this.getFinalAssistantText(childSession) : "";
		this.eventBus.emit({
			type: "session:subagent-progress",
			parentSessionId: pending.parentSessionId,
			childSessionId: sessionId,
			agentName: pending.displayName,
			task: pending.task,
			status: "running",
			partialOutput,
			usage: {
				input: pending.usage.input,
				output: pending.usage.output,
				cacheRead: pending.usage.cacheRead,
				cacheWrite: pending.usage.cacheWrite,
				cost: pending.usage.cost,
				turns: pending.usage.turns,
			},
			model: pending.model,
		});
		pending.onUpdate?.({
			childSessionId: sessionId,
			parentSessionId: pending.parentSessionId,
			agentName: pending.displayName,
			task: pending.task,
			status: "running",
			partialOutput,
			usage: pending.usage,
			model: pending.model,
		});
	}

	/** 取 session 最后一条 assistant 消息的文本输出。 */
	private getFinalAssistantText(session: AgentSession): string {
		const branch = session.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "assistant") {
				for (const part of entry.message.content) {
					if (part.type === "text") return part.text;
				}
			}
		}
		return "";
	}

	// ── Toggle ──

	isSubagentEnabled(sessionId: string): boolean {
		return this.subagentEnabledBySession.get(sessionId) ?? this.subagentDefaultEnabled;
	}

	setDefaultEnabled(enabled: boolean): void {
		this.subagentDefaultEnabled = enabled;
	}

	getDefaultEnabled(): boolean {
		return this.subagentDefaultEnabled;
	}

	async applyEnabled(sessionId: string, enabled: boolean): Promise<void> {
		this.subagentEnabledBySession.set(sessionId, enabled);
		const managed = this.runtimeStore.getRuntime(sessionId);
		if (!managed) return;
		const session = managed.session;

		if (enabled) {
			const configured = new Set(session.getAllTools().map((tool) => tool.name));
			if (!configured.has("subagent")) return;
			const active = session.getActiveToolNames();
			if (!active.includes("subagent")) session.setActiveToolsByName([...active, "subagent"]);
		} else {
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
		}
	}

	/** 新会话绑定时应用全局默认开关。 */
	applyDefaultOnBind(sessionId: string, session: AgentSession): void {
		if (this.subagentDefaultEnabled) return;
		this.subagentEnabledBySession.set(sessionId, false);
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
	}

	hasPending(sessionId: string): boolean {
		return this.pendingSubSessions.has(sessionId);
	}

	// ── Cleanup ──

	async abortSubSessions(parentSessionId: string): Promise<void> {
		const childIds = this.listSubSessions(parentSessionId);
		await Promise.all(
			childIds.map(async (childId) => {
				const child = this.runtimeStore.getRuntime(childId);
				if (child?.session.isStreaming) {
					await child.session.abort().catch(() => undefined);
				}
			}),
		);
	}

	disposeSession(childSessionId: string): void {
		const meta = this.subSessionMeta.get(childSessionId);
		if (meta) {
			const set = this.subSessionRegistry.get(meta.parentSessionId);
			set?.delete(childSessionId);
			if (set && set.size === 0) this.subSessionRegistry.delete(meta.parentSessionId);
		}
		this.subSessionMeta.delete(childSessionId);
		this.pendingSubSessions.delete(childSessionId);
		this.subagentEnabledBySession.delete(childSessionId);
	}

	// ── Lightweight JSONL scanning ──

	scanSubsessionMeta(filePath: string): SubsessionScanMeta | null {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const lines = raw.split("\n");
			let sessionId = "";
			let displayName: string | undefined;
			let parentSessionId: string | undefined;
			let agentName: string | undefined;
			let firstMessage: string | undefined;
			let messageCount = 0;
			let created = Date.now();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as Record<string, unknown>;
					if (entry.type === "session") {
						sessionId = String(entry.id ?? "");
						if (entry.timestamp) created = new Date(String(entry.timestamp)).getTime();
					} else if (entry.type === "session_info") {
						displayName = String(entry.name ?? "") || undefined;
					} else if (entry.type === "custom" && entry.customType === SUBAGENT_PARENT_ENTRY_TYPE) {
						const data = entry.data as { parentSessionId?: string; agentName?: string } | undefined;
						if (data?.parentSessionId) parentSessionId = data.parentSessionId;
						if (data?.agentName) agentName = data.agentName;
					} else if (entry.type === "message") {
						messageCount++;
						if (!firstMessage) {
							const msg = entry.message as { content?: unknown; timestamp?: number } | undefined;
							const content = msg?.content;
							if (typeof content === "string") firstMessage = content;
							else if (Array.isArray(content) && (content[0] as { type?: string })?.type === "text") {
								firstMessage = (content[0] as { text: string }).text;
							}
							if (msg?.timestamp && msg.timestamp < created) created = msg.timestamp;
						}
					}
				} catch {
					/* skip malformed lines */
				}
			}
			if (!sessionId) return null;
			return { sessionId, displayName, parentSessionId, agentName, firstMessage, messageCount, created };
		} catch {
			return null;
		}
	}
}
