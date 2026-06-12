// ============================================================
// PermissionAskService — Async question panel for tool calls.
//
// When pi's `tool_call` extension hook wants to ask the user, it
// calls `ask(agentId, request)`. We register a pending ask, emit
// a `permission:ask` event to the renderer, and return a Promise
// that resolves when the user clicks Allow / Allow-with-edits /
// Deny in the PermissionDialog.
//
// The main process owns the timeout. If the renderer reloads,
// crashes, or never responds, the suspended tool call is denied
// automatically instead of waiting forever.
// ============================================================

import type { PermissionDecision } from "../shared/types.js";

export interface PermissionAskRequest {
	/** Matches `event.toolCallId` from pi — used as the request id. */
	requestId: string;
	agentId: string;
	toolName: string;
	args: Record<string, unknown>;
	reason: string;
}

type PermissionAskEvent =
	| ({ type: "permission:ask" } & PermissionAskRequest)
	| {
			type: "permission:resolved";
			requestId: string;
			agentId: string;
			decision: PermissionDecision;
	  };

interface PendingAsk {
	request: PermissionAskRequest;
	resolve: (decision: PermissionDecision) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class PermissionAskService {
	/** Pending ask resolvers, keyed by requestId. */
	private resolvers = new Map<string, PendingAsk>();
	/** Ordered list of pending ask requestIds (renderer maintains the queue UI). */
	private pending: string[] = [];

	constructor(
		private emit: (event: PermissionAskEvent) => void,
		private timeoutMs = DEFAULT_TIMEOUT_MS,
	) {}

	/**
	 * Submit a permission ask. Returns a Promise that resolves with
	 * the user's decision (allow / deny / edit-with-patched-args).
	 * The caller (`tool_call` extension hook) is suspended on this
	 * Promise until the user makes a choice.
	 */
	ask(agentId: string, request: PermissionAskRequest): Promise<PermissionDecision> {
		return new Promise<PermissionDecision>((resolve) => {
			if (this.resolvers.has(request.requestId)) {
				this.resolve(request.requestId, {
					action: "deny",
					reason: "Superseded by a newer permission request",
				});
			}
			const fullRequest = { ...request, agentId };
			const timer =
				Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
					? setTimeout(() => {
							this.resolve(request.requestId, {
								action: "deny",
								reason: `Timed out (${Math.round(this.timeoutMs / 1000)}s)`,
							});
						}, this.timeoutMs)
					: null;
			timer?.unref?.();
			this.resolvers.set(request.requestId, { request: fullRequest, resolve, timer });
			this.pending.push(request.requestId);
			this.emit({ type: "permission:ask", ...fullRequest });
		});
	}

	/**
	 * Called by the IPC handler when the renderer responds.
	 * Resolves the matching ask and removes it from the queue.
	 */
	resolve(requestId: string, decision: PermissionDecision): void {
		const pending = this.resolvers.get(requestId);
		if (!pending) return; // unknown / already-resolved ask — ignore
		if (pending.timer) clearTimeout(pending.timer);
		this.resolvers.delete(requestId);
		this.pending = this.pending.filter((id) => id !== requestId);
		pending.resolve(decision);
		this.emit({
			type: "permission:resolved",
			requestId,
			agentId: pending.request.agentId,
			decision,
		});
	}

	/** True if there are any pending asks for this agent. */
	hasPending(agentId: string): boolean {
		return this.pending.some((id) => this.resolvers.get(id)?.request.agentId === agentId);
	}

	/** Current queue (renderer reads to render the queue UI). */
	queue(): string[] {
		return [...this.pending];
	}
}
