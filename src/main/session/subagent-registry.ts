// ============================================================
// SubAgentRegistry — parent-child session bookkeeping
//
// Extracted from SessionRuntimeManager. Owns the in-memory registry
// of sub-session relationships (parent → children, child → parent)
// and pending execution tracking. All Map lookups are O(1).
//
// Does NOT manage session lifecycle, runtime creation, or event
// emission — those remain in SRT.
// ============================================================

import type {
	AgentConfig,
	SubagentProgress,
	SubagentResult,
	SubagentUsage,
} from "../extensions/subagent/types.js";

// ── Internal types ──

export interface PendingSubSession {
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

export class SubAgentRegistry {
	/** parentSessionId → Set<childSessionId> */
	private readonly children = new Map<string, Set<string>>();

	/** childSessionId → { parentSessionId, agentName } */
	private readonly meta = new Map<string, { parentSessionId: string; agentName: string }>();

	/** childSessionId → PendingSubSession (awaits agent_end resolve) */
	private readonly pending = new Map<string, PendingSubSession>();

	// ── Registration ──

	register(parentSessionId: string, childSessionId: string, agentName: string): void {
		let set = this.children.get(parentSessionId);
		if (!set) {
			set = new Set();
			this.children.set(parentSessionId, set);
		}
		set.add(childSessionId);
		this.meta.set(childSessionId, { parentSessionId, agentName });
	}

	unregister(childSessionId: string): void {
		const meta = this.meta.get(childSessionId);
		if (meta) {
			const siblings = this.children.get(meta.parentSessionId);
			if (siblings) {
				siblings.delete(childSessionId);
				if (siblings.size === 0) this.children.delete(meta.parentSessionId);
			}
		}
		this.meta.delete(childSessionId);
	}

	// ── Queries ──

	listChildren(parentSessionId: string): string[] {
		return Array.from(this.children.get(parentSessionId) ?? []);
	}

	getParent(childSessionId: string): string | null {
		return this.meta.get(childSessionId)?.parentSessionId ?? null;
	}

	getMeta(childSessionId: string): { parentSessionId: string; agentName: string } | undefined {
		return this.meta.get(childSessionId);
	}

	// ── Pending tracking ──

	addPending(pending: PendingSubSession): void {
		this.pending.set(pending.childSessionId, pending);
	}

	removePending(childSessionId: string): PendingSubSession | undefined {
		const p = this.pending.get(childSessionId);
		if (p) this.pending.delete(childSessionId);
		return p;
	}

	getPending(childSessionId: string): PendingSubSession | undefined {
		return this.pending.get(childSessionId);
	}

	hasPending(childSessionId: string): boolean {
		return this.pending.has(childSessionId);
	}

	/** Release all pending sub-sessions for a parent. */
	abortPendingForParent(parentSessionId: string): void {
		const childIds = this.listChildren(parentSessionId);
		for (const childId of childIds) {
			const p = this.pending.get(childId);
			if (p) {
				p.aborted = true;
				p.removeAbortListener();
				this.pending.delete(childId);
				p.resolve({
					sessionId: childId,
					agentName: p.displayName,
					agentSource: p.agent.source,
					task: p.task,
					status: "aborted",
					finalOutput: "",
					usage: p.usage,
					model: p.model,
					stopReason: p.stopReason,
					errorMessage: p.errorMessage,
				});
			}
		}
	}
}
