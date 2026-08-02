// ============================================================
// DesktopNotifierService — OS-level desktop notifications
//
// Subscribes to the shared IEventBus (same bus that feeds the
// renderer) and surfaces "needs action", "task finished" and
// "error" events as native OS notifications — but ONLY when the
// main window is not focused (if the user is looking at the app,
// the in-app toast / dialogs already cover it).
//
// Clicking a notification focuses the window and, when the event
// carries an agentId, emits `notification:activate-session` so the
// renderer can activate that session.
//
// Deliberately OUTSIDE the existing session event pipeline: it only
// subscribes and never mutates runtime state.
// ============================================================

import type { AgentInfo, MainToRendererEvent, UserSettings } from "@look/shared/types";
import type { BrowserWindow } from "electron";
import { Notification } from "electron";
import type { IEventBus } from "../core/contracts.js";
import { notificationStrings } from "./notification-strings.js";

export type DesktopNotificationKind = "needs-action" | "completed" | "error";

interface DesktopNotifierDeps {
	eventBus: IEventBus;
	getMainWindow: () => BrowserWindow | null | undefined;
	getSettings: () => UserSettings;
	getAgentInfo: (sessionId: string) => AgentInfo | undefined;
}

/** Debounce window for repeated notifications on the same key. */
const DEBOUNCE_MS = 5_000;

export class DesktopNotifierService {
	private readonly deps: DesktopNotifierDeps;
	private unsubscribe: (() => void) | null = null;
	/** lastShownAt per `${kind}:${agentId ?? "global"}` key. */
	private readonly lastShownAt = new Map<string, number>();
	/** Sessions that have been destroyed; notifications for them are suppressed. */
	private readonly destroyedSessions = new Set<string>();

	constructor(deps: DesktopNotifierDeps) {
		this.deps = deps;
	}

	/** Start listening to the event bus. Idempotent. */
	subscribe(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.deps.eventBus.onEvent((event) => this.handleEvent(event));
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.lastShownAt.clear();
	}

	// ── Event mapping ──

	private handleEvent(event: MainToRendererEvent): void {
		const strings = notificationStrings(this.deps.getSettings().language);
		switch (event.type) {
			case "permission:ask":
				this.maybeNotify({
					kind: "needs-action",
					agentId: event.agentId,
					title: this.title(event.agentId, "needs-action"),
					body: strings.permissionBody(this.sessionName(event.agentId), event.event.toolName),
				});
				break;

			case "plan:question-requested":
				this.maybeNotify({
					kind: "needs-action",
					agentId: event.agentId,
					title: this.title(event.agentId, "needs-action"),
					body: strings.planQuestionBody(this.sessionName(event.agentId)),
				});
				break;

			case "plan:approval-requested":
				this.maybeNotify({
					kind: "needs-action",
					agentId: event.agentId,
					title: this.title(event.agentId, "needs-action"),
					body: strings.planApprovalBody(this.sessionName(event.agentId)),
				});
				break;

			case "login:prompt":
				this.maybeNotify({
					kind: "needs-action",
					agentId: undefined,
					title: strings.loginTitle,
					body: strings.loginBody,
				});
				break;

			case "session:snapshot":
				// agent_end carries willRetry=false → runtime.isStreaming=false.
				// A retry (willRetry=true) keeps isStreaming truthy, so we
				// only notify on genuine turn completion. Subagent child
				// sessions are suppressed to avoid notification spam.
				if (event.reason === "agent_end" && !event.runtime.isStreaming && !event.runtime.isRetrying) {
					const info = this.deps.getAgentInfo(event.sessionId);
					if (info?.isSubagentSession || info?.parentSessionId) return;
					this.maybeNotify({
						kind: "completed",
						agentId: event.sessionId,
						title: this.title(event.sessionId, "completed"),
						body: strings.completedBody(this.sessionName(event.sessionId)),
					});
				}
				break;

			case "error":
				this.maybeNotify({
					kind: "error",
					agentId: event.agentId,
					title: this.title(event.agentId, "error"),
					body: event.agentId
						? strings.errorBodyWithSession(this.sessionName(event.agentId), event.message)
						: strings.errorBodyGlobal(event.message),
				});
				break;

			case "agent:destroyed":
				// 会话销毁后不再为其弹通知。
				this.destroyedSessions.add(event.agentId);
				for (const kind of ["needs-action", "completed", "error"] as const) {
					this.lastShownAt.delete(`${kind}:${event.agentId}`);
				}
				break;

			default:
				break;
		}
	}

	// ── Decision & delivery ──

	private maybeNotify(input: { kind: DesktopNotificationKind; agentId?: string; title: string; body: string }): void {
		const mode = this.deps.getSettings().desktopNotifications ?? "all";
		if (mode === "off") return;
		if (mode === "needs-action" && input.kind !== "needs-action") return;
		if (input.agentId && this.destroyedSessions.has(input.agentId)) return;

		const win = this.deps.getMainWindow();
		if (win && !win.isDestroyed() && win.isFocused()) return;

		const key = `${input.kind}:${input.agentId ?? "global"}`;
		const now = Date.now();
		const last = this.lastShownAt.get(key) ?? 0;
		if (now - last < DEBOUNCE_MS) return;
		this.lastShownAt.set(key, now);

		this.showNotification(input);
	}

	private showNotification(input: { agentId?: string; title: string; body: string }): void {
		if (!Notification.isSupported()) return;
		const notification = new Notification({ title: input.title, body: input.body });
		notification.on("click", () => this.onClick(input.agentId));
		// macOS dev 模式（adhoc 签名 com.github.Electron）系统可能拒绝通知权限，
		// show() 会以 UNErrorDomain 错误 1 失败。记录日志便于诊断，避免静默失败。
		notification.on("failed", (_event, error) => {
			console.warn(`[Look][DesktopNotifier] Notification failed (title=${input.title}): ${error}`);
		});
		notification.show();
	}

	private onClick(agentId: string | undefined): void {
		const win = this.deps.getMainWindow();
		if (win && !win.isDestroyed()) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		}
		if (agentId) {
			this.deps.eventBus.emit({ type: "notification:activate-session", agentId });
		}
	}

	// ── Helpers ──

	private sessionName(agentId: string | undefined): string {
		if (!agentId) return notificationStrings(this.deps.getSettings().language).fallbackSessionName;
		return (
			this.deps.getAgentInfo(agentId)?.name ??
			notificationStrings(this.deps.getSettings().language).fallbackSessionName
		);
	}

	private title(agentId: string | undefined, kind: DesktopNotificationKind): string {
		const strings = notificationStrings(this.deps.getSettings().language);
		const base = agentId ? this.sessionName(agentId) : "LOOK";
		switch (kind) {
			case "needs-action":
				return `${base} · ${strings.needsActionTitleSuffix}`;
			case "completed":
				return `${base} · ${strings.completedTitleSuffix}`;
			case "error":
				return `${base} · ${strings.errorTitleSuffix}`;
		}
	}
}
