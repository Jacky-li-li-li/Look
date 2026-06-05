// ============================================================
// PermissionAskService — Async question panel for tool calls.
//
// When pi's `tool_call` extension hook wants to ask the user, it
// calls `ask(agentId, request)`. We register a pending ask, emit
// a `permission:ask` event to the renderer, and return a Promise
// that resolves when the user clicks Allow / Allow-with-edits /
// Deny in the PermissionDialog.
//
// The renderer is the source of truth for *queueing* and *time-
// outs*. We just provide the ask/resolve plumbing; if the user
// never responds, the ask stays pending and the dialog stays
// open. (Renderer-side code adds a default-deny timer.)
// ============================================================

import type { EventEmitter } from "node:events";
import type { PermissionDecision } from "../shared/types.js";

export interface PermissionAskRequest {
  /** Matches `event.toolCallId` from pi — used as the request id. */
  requestId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

export class PermissionAskService {
  /** Pending ask resolvers, keyed by requestId. */
  private resolvers = new Map<string, (decision: PermissionDecision) => void>();
  /** Ordered list of pending ask requestIds (renderer maintains the queue UI). */
  private pending: string[] = [];

  constructor(private emit: (event: { type: "permission:ask"; } & PermissionAskRequest) => void) {}

  /**
   * Submit a permission ask. Returns a Promise that resolves with
   * the user's decision (allow / deny / edit-with-patched-args).
   * The caller (`tool_call` extension hook) is suspended on this
   * Promise until the user makes a choice.
   */
  ask(agentId: string, request: PermissionAskRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.resolvers.set(request.requestId, resolve);
      this.pending.push(request.requestId);
      this.emit({ type: "permission:ask", ...request, agentId });
    });
  }

  /**
   * Called by the IPC handler when the renderer responds.
   * Resolves the matching ask and removes it from the queue.
   */
  resolve(requestId: string, decision: PermissionDecision): void {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return; // unknown / already-resolved ask — ignore
    this.resolvers.delete(requestId);
    this.pending = this.pending.filter((id) => id !== requestId);
    resolver(decision);
  }

  /** True if there are any pending asks for this agent. */
  hasPending(agentId: string): boolean {
    return this.pending.length > 0;
  }

  /** Current queue (renderer reads to render the queue UI). */
  queue(): string[] {
    return [...this.pending];
  }
}
