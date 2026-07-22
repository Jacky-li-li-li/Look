// ============================================================
// PermissionService — per-session tool call authorization
//
// Owns the permission state (mode, allowed tools, pending requests)
// and provides the tool_call handler injected into pi SDK extensions.
//
// Three modes (Pi-aligned gate):
//   "always"  — all tools pass without question
//   "ask"     — intercepted tools prompt the user via IPC; supports
//               per-tool "allow_always" grants within a session
//   "plan"    — strict read-only; bash limited to pwd + git read ops
//
// Extracted from SessionRuntimeManager (Phase 2 refactor).
// Updated Phase B: depends on IEventBus + IRuntimeStore instead of callbacks.
// ============================================================

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PermissionAskEvent, PermissionMode, PermissionRespondPayload, ToolCallHandler } from "@look/shared/types";
import { v4 as uuidv4 } from "uuid";
import type { IEventBus, IPermissionService } from "../core/contracts.js";
import { createPlanModeHandler } from "../extensions/permission-extension.js";
import { defaultCapabilityRegistry, type CapabilityRegistry } from "./capability-registry.js";

// ── Constants ──

export const PERMISSION_MODE_ENTRY_TYPE = "look.permission-mode.v1";
const PERMISSION_TIMEOUT_MS = 30_000;

type PermissionAction = "allow" | "deny" | "allow_always";

interface PendingPermission {
	sessionId: string;
	resolve: (action: PermissionAction) => void;
	timeout: ReturnType<typeof setTimeout>;
}

// ── Validation ──

export function isValidPermissionMode(value: unknown): value is PermissionMode {
	return value === "always" || value === "ask" || value === "plan";
}

// ── Service ──

export class PermissionService implements IPermissionService {
	private readonly modes = new Map<string, PermissionMode>();
	private readonly dirty = new Set<string>();
	private readonly awaiting = new Map<string, PendingPermission>();
	private readonly allowedTools = new Map<string, Set<string>>();

	private defaultMode: PermissionMode;

	constructor(
		private readonly eventBus: IEventBus,
		initialDefaultMode: PermissionMode = "ask",
		private readonly capabilities: CapabilityRegistry = defaultCapabilityRegistry,
	) {
		this.defaultMode = initialDefaultMode;
	}

	// ── Mode accessors ──

	getMode(sessionId: string): PermissionMode {
		return this.modes.get(sessionId) ?? this.defaultMode;
	}

	setDefaultMode(mode: PermissionMode): void {
		this.defaultMode = mode;
	}

	getDefaultMode(): PermissionMode {
		return this.defaultMode;
	}

	setMode(sessionId: string, mode: PermissionMode): void {
		this.modes.set(sessionId, mode);
		this.allowedTools.delete(sessionId);
		this.dirty.add(sessionId);
	}

	restoreFromSession(sessionId: string, manager: SessionManager): PermissionMode {
		let mode = this.defaultMode;
		let hasSavedMode = false;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PERMISSION_MODE_ENTRY_TYPE) continue;
			const savedMode = (entry.data as { mode?: unknown } | undefined)?.mode;
			if (isValidPermissionMode(savedMode)) {
				mode = savedMode;
				hasSavedMode = true;
			}
		}
		this.modes.set(sessionId, mode);
		if (!hasSavedMode) {
			if (manager.isPersisted()) {
				manager.appendCustomEntry(PERMISSION_MODE_ENTRY_TYPE, { mode });
			} else {
				this.dirty.add(sessionId);
			}
		}
		return mode;
	}

	persistIfDirty(sessionId: string, manager: SessionManager): void {
		if (!this.dirty.has(sessionId)) return;
		if (!manager.isPersisted()) return;
		const mode = this.modes.get(sessionId);
		if (!mode) return;
		manager.appendCustomEntry(PERMISSION_MODE_ENTRY_TYPE, { mode });
		this.dirty.delete(sessionId);
	}

	disposeSession(sessionId: string): void {
		this.modes.delete(sessionId);
		this.dirty.delete(sessionId);
		this.allowedTools.delete(sessionId);
	}

	// ── Tool call handler ──

	createToolCallHandler(cwd: string): ToolCallHandler {
		const planHandler = createPlanModeHandler(cwd);

		return async (event, _ctx) => {
			const sessionId = _ctx.sessionManager.getSessionId();
			const mode = this.getMode(sessionId);

			if (mode === "always") return {};
			const toolName = event.toolName;
			const capability = this.capabilities.resolve(toolName);
			if (mode === "plan") {
				if (capability.requiresExplicitApproval) {
					return { block: true, reason: `Plan mode does not allow ${capability.kind} capability: ${toolName}` };
				}
				return planHandler(event, _ctx);
			}

			const allowedTools = this.allowedTools.get(sessionId);
			if (allowedTools?.has(toolName)) return {};

			const requestId = uuidv4();
			const expiresAt = Date.now() + PERMISSION_TIMEOUT_MS;
			const askEvent: PermissionAskEvent = {
				toolName,
				toolInput: (event.input ?? {}) as Record<string, unknown>,
				toolDescription: capability.description,
				requestId,
				expiresAt,
			};

			const actionPromise = new Promise<PermissionAction>((resolve) => {
				const timeout = setTimeout(() => {
					this.finishRequest(requestId, "deny");
				}, PERMISSION_TIMEOUT_MS);
				this.awaiting.set(requestId, { sessionId, resolve, timeout });
			});
			this.eventBus.emit({ type: "permission:ask", agentId: sessionId, event: askEvent });
			const action = await actionPromise;

			if (action === "allow_always") {
				const grants = this.allowedTools.get(sessionId) ?? new Set<string>();
				grants.add(toolName);
				this.allowedTools.set(sessionId, grants);
				return {};
			}
			if (action === "allow") return {};
			return { block: true, reason: `用户拒绝了 ${toolName} 工具调用` };
		};
	}

	// ── Response handling ──

	handleResponse(payload: PermissionRespondPayload): boolean {
		return this.finishRequest(payload.requestId, payload.action);
	}

	finishRequest(requestId: string, action: PermissionAction): boolean {
		const pending = this.awaiting.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timeout);
		this.awaiting.delete(requestId);
		pending.resolve(action);
		this.eventBus.emit({ type: "permission:resolved", agentId: pending.sessionId, requestId });
		return true;
	}

	cancelPending(sessionId: string): void {
		for (const [requestId, pending] of Array.from(this.awaiting.entries())) {
			if (pending.sessionId === sessionId) this.finishRequest(requestId, "deny");
		}
	}
}
