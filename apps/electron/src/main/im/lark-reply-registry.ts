// ============================================================
// Lark reply registry — sessionId → ReplyAccumulator 与事件终结
// Extracted from LarkBridgeService so streaming/stop/agent_end stay cohesive
// without the bridge owning the map directly.
// ============================================================

import type { MainToRendererEvent } from "@look/shared/types";
import type { LarkReplyPresenter, ReplyAccumulator } from "./lark-reply-presenter.js";

type SnapshotEvent = Extract<MainToRendererEvent, { type: "session:snapshot" }>;

/**
 * Owns in-flight reply accumulators and applies agent UI/snapshot/error events.
 * Presenter still builds cards; the bridge drives stream() / sendMessage.
 */
export class LarkReplyRegistry {
	private readonly accumulators = new Map<string, ReplyAccumulator>();
	private readonly ownerAppIds = new Map<string, string>();

	constructor(
		private readonly presenter: LarkReplyPresenter,
		private readonly hooks: {
			onAgentEnd?: (sessionId: string) => void;
			extractTerminalAssistantText?: (entries: SnapshotEvent["entries"]) => string;
		} = {},
	) {}

	get size(): number {
		return this.accumulators.size;
	}

	get(sessionId: string): ReplyAccumulator | undefined {
		return this.accumulators.get(sessionId);
	}

	/** Accumulators that are still streaming (for status reporting). */
	runningSessionIds(): string[] {
		const running: string[] = [];
		for (const [sessionId, acc] of this.accumulators) {
			if (!acc.done) running.push(sessionId);
		}
		return running;
	}

	release(sessionId: string, reason: string): void {
		const acc = this.accumulators.get(sessionId);
		if (acc) this.presenter.disposeAccumulator(acc, reason);
		this.accumulators.delete(sessionId);
		this.ownerAppIds.delete(sessionId);
	}

	releaseAll(reason: string): void {
		for (const acc of this.accumulators.values()) {
			this.presenter.disposeAccumulator(acc, reason);
		}
		this.accumulators.clear();
		this.ownerAppIds.clear();
	}

	releaseOwnedByApp(appId: string, reason: string): void {
		for (const [sessionId, owner] of Array.from(this.ownerAppIds.entries())) {
			if (owner === appId) this.release(sessionId, reason);
		}
	}

	clearOwners(): void {
		this.ownerAppIds.clear();
	}

	/**
	 * Ensure an open accumulator for this session (reuse if still in-flight).
	 */
	ensure(sessionId: string, appId: string, userText: string): ReplyAccumulator {
		let acc = this.accumulators.get(sessionId);
		if (!acc || acc.done) {
			acc = this.presenter.createAccumulator(sessionId, userText);
			this.accumulators.set(sessionId, acc);
			this.ownerAppIds.set(sessionId, appId);
		} else {
			acc.userText = userText;
		}
		return acc;
	}

	/**
	 * Mark an in-flight accumulator as user-stopped, flush final card, then release.
	 * Shared by /stop and card stop button.
	 */
	async finalizeStopped(sessionId: string, logLine: string, releaseReason: string): Promise<boolean> {
		const acc = this.accumulators.get(sessionId);
		if (!acc || acc.done) return false;
		acc.status = "error";
		acc.error = "已停止";
		acc.logs.push(logLine);
		acc.done = true;
		acc.resolveDone();
		await this.presenter.flushUpdate(acc, true);
		this.release(sessionId, releaseReason);
		return true;
	}

	/** Agent runtime events → accumulator text / tool panels / terminal status. */
	handleAgentEvent(event: MainToRendererEvent): void {
		if (event.type === "session:ui-event") {
			const acc = this.accumulators.get(event.sessionId);
			if (!acc) return;

			let immediateUpdate = false;
			for (const uiEvent of event.events) {
				this.presenter.applyUiEvent(acc, uiEvent);
				if (
					uiEvent.type === "tool_exec_start" ||
					uiEvent.type === "tool_exec_end" ||
					uiEvent.type === "error" ||
					(uiEvent.type === "run_status" && uiEvent.status === "idle")
				) {
					immediateUpdate = true;
				}
			}
			if (immediateUpdate) this.presenter.scheduleUpdate(acc, 0);
			else this.presenter.scheduleUpdate(acc);
		}

		if (event.type === "session:snapshot" && event.reason === "agent_end") {
			this.hooks.onAgentEnd?.(event.sessionId);
			const acc = this.accumulators.get(event.sessionId);
			if (acc && !acc.done && !event.runtime.isStreaming) {
				const fallback = this.hooks.extractTerminalAssistantText?.(event.entries) ?? "";
				this.presenter.applyFinalTextFallback(acc, fallback);
				console.log(
					"[LarkReplyRegistry] Agent turn ended for session",
					event.sessionId,
					"accumulated text length:",
					acc.text.length,
				);
				if (event.runtime.model) {
					acc.model = `${event.runtime.model.provider}/${event.runtime.model.id}`;
				}
				const tokens = event.runtime.stats?.tokens;
				if (tokens) {
					acc.inputTokens = tokens.input;
					acc.outputTokens = tokens.output;
				}
				acc.status = acc.error ? "error" : "done";
				acc.done = true;
				acc.resolveDone();
				this.presenter.scheduleUpdate(acc, 0);
			}
		}

		if (event.type === "error" && event.agentId) {
			const acc = this.accumulators.get(event.agentId);
			if (acc && !acc.done) {
				console.warn("[LarkReplyRegistry] Agent error for session", event.agentId, ":", event.message);
				acc.error = event.message;
				acc.status = "error";
				acc.logs.push(event.message);
				acc.done = true;
				acc.resolveDone();
				this.presenter.scheduleUpdate(acc, 0);
			}
		}
	}
}
