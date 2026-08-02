// ============================================================
// LookIslandService — orchestrates the macOS Look Island
//
// Subscribes to the session event bus, reduces events into a
// display snapshot, and pushes it to the native Swift helper via
// LookIslandNativeHost. Publishing is throttled and snapshot-diffed
// so high-frequency streaming events do not spam the helper.
// ============================================================

import type { LookIslandDisplayState, LookIslandNativeFrame, MainToRendererEvent } from "@look/shared/types";
import type { BrowserWindow, Display, Rectangle } from "electron";
import type { LookIslandLayoutStore } from "./layout-store.js";
import { LookIslandNativeHost } from "./native-host.js";
import {
	applyLookIslandEvent,
	buildLookIslandDisplayState,
	collapseLookIsland,
	createLookIslandState,
	type LookIslandState,
	pruneLookIslandSessions,
	requestLookIslandExpand,
	resetLookIslandState,
	setLookIslandAppFocused,
	showLookIslandIdleFeedback,
} from "./reducer.js";

const PUBLISH_THROTTLE_MS = 80;
const LOOK_ISLAND_IDLE_FEEDBACK_MS = 4_000;

export interface LookIslandServiceDeps {
	/** SessionEventBus subscription (runtimeManager.composition.eventBus.onEvent). */
	onEvent: (callback: (event: MainToRendererEvent) => void) => () => void;
	getMainWindow: () => BrowserWindow | null;
	getPrimaryDisplay: () => Display;
	getAllDisplays: () => Display[];
	/** Delivers an event to the renderer (activates sessions). */
	emitEvent: (event: MainToRendererEvent) => void;
	/** Resolves a pending permission request (permission.service.handleResponse). */
	permissionResponder: {
		handleResponse: (payload: { requestId: string; action: "allow" | "deny" | "allow_always" }) => boolean;
	};
	/** Resolves a pending plan approval (plan.handleApprovalResponse). */
	planResponder: {
		handleApprovalResponse: (payload: {
			requestId: string;
			sessionId: string;
			action: "approve" | "reject";
		}) => Promise<boolean> | boolean;
	};
	/** Layout preference store (per-display position / width). */
	layoutStore: LookIslandLayoutStore;
	isPlatformSupported: () => boolean;
}

export interface LookIslandService {
	start(): void;
	stop(): void;
	/** Temporarily hides the island but keeps it reusable (settings off). */
	disable(): void;
	/** Re-enables after disable(). */
	enable(): void;
}

export function initLookIslandService(deps: LookIslandServiceDeps): LookIslandService | null {
	if (!deps.isPlatformSupported()) return null;
	return new LookIslandServiceImpl(deps);
}

class LookIslandServiceImpl implements LookIslandService {
	private readonly state: LookIslandState = createLookIslandState();
	private readonly nativeHost: LookIslandNativeHost;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPublishedState: LookIslandDisplayState | null = null;
	private hiddenPublished = false;
	private stopped = false;
	private started = false;
	private permanentlyStopped = false;
	private focusedMainWindow = false;
	private unsubscribeEvent: (() => void) | null = null;
	private unsubscribeFocus: (() => void) | null = null;
	private unsubscribeBlur: (() => void) | null = null;

	constructor(private readonly deps: LookIslandServiceDeps) {
		this.nativeHost = new LookIslandNativeHost({
			onExpand: () => {
				if (requestLookIslandExpand(this.state)) this.schedulePublish();
			},
			onFocusSession: (sessionId) => {
				this.focusSession(sessionId);
			},
			onOutsideClick: () => {
				if (collapseLookIsland(this.state)) this.schedulePublish();
			},
			onPermissionAction: (requestId, action) => {
				this.resolvePermission(requestId, action);
			},
			onPlanAction: (requestId, sessionId, action) => {
				void this.resolvePlan(requestId, sessionId, action);
			},
			onLayoutPreference: (pref) => {
				this.applyLayoutPreference(pref);
			},
			onScreenMetrics: () => {
				// M1: native metrics are informational; geometry stays in main.
			},
		});
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribeEvent = this.deps.onEvent((event) => {
			if (event.type === "window:fullscreen-changed") return;
			this.applyEvent(event);
		});
		const mainWindow = this.deps.getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			const onFocus = () => {
				if (setLookIslandAppFocused(this.state, true)) this.schedulePublish();
			};
			const onBlur = () => {
				if (setLookIslandAppFocused(this.state, false)) this.schedulePublish();
			};
			mainWindow.on("focus", onFocus);
			mainWindow.on("blur", onBlur);
			this.unsubscribeFocus = () => mainWindow.removeListener("focus", onFocus);
			this.unsubscribeBlur = () => mainWindow.removeListener("blur", onBlur);
			this.focusedMainWindow = mainWindow.isFocused();
		}
		setLookIslandAppFocused(this.state, this.focusedMainWindow);
	}

	stop(): void {
		this.stopped = true;
		this.permanentlyStopped = true;
		this.started = false;
		this.clearPublishTimer();
		this.unsubscribeEvent?.();
		this.unsubscribeFocus?.();
		this.unsubscribeBlur?.();
		this.unsubscribeEvent = null;
		this.unsubscribeFocus = null;
		this.unsubscribeBlur = null;
		this.nativeHost.stop();
	}

	/** Settings off — tear down the helper but keep the service reusable. */
	disable(): void {
		this.stopped = true;
		this.clearPublishTimer();
		this.nativeHost.suspend();
	}

	/** Settings on — bring the island back. */
	enable(): void {
		if (this.permanentlyStopped) return;
		this.stopped = false;
		showLookIslandIdleFeedback(this.state, Date.now() + LOOK_ISLAND_IDLE_FEEDBACK_MS);
		if (!this.started) {
			this.start();
		} else {
			this.schedulePublish();
		}
	}

	private applyEvent(event: MainToRendererEvent): void {
		if (this.stopped) return;
		if (applyLookIslandEvent(this.state, event, Date.now())) {
			this.schedulePublish();
		}
	}

	private schedulePublish(): void {
		if (this.publishTimer) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null;
			this.publishNow();
		}, PUBLISH_THROTTLE_MS);
	}

	private publishNow(): void {
		if (this.stopped) return;
		const now = Date.now();
		pruneLookIslandSessions(this.state, now);
		const display = this.deps.getPrimaryDisplay();
		const next = buildLookIslandDisplayState(this.state, { appFocused: this.state.appFocused }, now);

		if (this.lastPublishedState && sameDisplayState(this.lastPublishedState, next)) {
			if (!next.visible && !this.hiddenPublished) {
				this.hiddenPublished = true;
				this.publishToNative(next, display);
			}
			return;
		}
		this.hiddenPublished = !next.visible;
		this.lastPublishedState = next;
		this.publishToNative(next, display);
	}

	private publishToNative(state: LookIslandDisplayState, display: Display): void {
		const frame = computeNativeFrame(display, state, this.deps.layoutStore);
		this.nativeHost.publish(state, frame);
	}

	private focusMainWindow(): void {
		const window = this.deps.getMainWindow();
		if (!window || window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	}

	/** Focus the app and switch the renderer to the given session. */
	private focusSession(sessionId: string): void {
		collapseLookIsland(this.state);
		this.deps.emitEvent({
			type: "notification:activate-session",
			agentId: sessionId,
		});
		this.focusMainWindow();
		this.schedulePublish();
	}

	private resolvePermission(requestId: string, action: "allow" | "allowForSession" | "deny"): void {
		const mapped = action === "allowForSession" ? "allow_always" : action;
		const accepted = this.deps.permissionResponder.handleResponse({ requestId, action: mapped });
		if (accepted) {
			// permission:resolved will clear the blocking card via the event bus.
			this.schedulePublish();
		}
	}

	private async resolvePlan(requestId: string, sessionId: string, action: "approve" | "reject"): Promise<void> {
		try {
			const accepted = await this.deps.planResponder.handleApprovalResponse({ requestId, sessionId, action });
			if (accepted) {
				this.schedulePublish();
			}
		} catch (error) {
			console.warn("[Look] Look Island plan action failed:", error);
		}
	}

	private applyLayoutPreference(pref: {
		displayId?: number | null;
		centerXRatio?: number | null;
		contentWidth?: number | null;
		expanded?: boolean;
	}): void {
		const displayId = pref.displayId ?? this.deps.getPrimaryDisplay().id;
		this.deps.layoutStore.updateForDisplay(displayId, {
			centerXRatio: pref.centerXRatio,
			...(pref.expanded ? { expandedContentWidth: pref.contentWidth } : { compactContentWidth: pref.contentWidth }),
		});
		this.schedulePublish();
	}

	private clearPublishTimer(): void {
		if (!this.publishTimer) return;
		clearTimeout(this.publishTimer);
		this.publishTimer = null;
	}
}

function computeNativeFrame(
	display: Display,
	state: LookIslandDisplayState,
	layoutStore: LookIslandLayoutStore,
): LookIslandNativeFrame {
	const bounds = display.bounds as Rectangle;
	const expanded = state.mode === "expanded";
	const pref = layoutStore.getForDisplay(display.id);
	const maxWidth = Math.max(1, bounds.width - 224);
	const contentWidth = expanded
		? clampWidth(pref?.expandedContentWidth ?? Math.min(640, maxWidth), 360, maxWidth)
		: clampWidth(pref?.compactContentWidth ?? null, 80, maxWidth);
	return {
		displayId: display.id,
		displayBounds: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		},
		contentWidth: expanded || pref?.compactContentWidth != null ? contentWidth : null,
		centerXRatio: pref?.centerXRatio ?? null,
	};
}

function clampWidth(value: number | null, min: number, max: number): number {
	if (value == null) return Math.min(max, min);
	return Math.min(max, Math.max(min, value));
}

function sessionFingerprint(sessions: LookIslandDisplayState["sessions"]): string {
	return sessions.map((s) => `${s.sessionId}:${s.phase}:${s.lastActivityAt}:${s.detail}`).join("|");
}

function sameDisplayState(a: LookIslandDisplayState, b: LookIslandDisplayState): boolean {
	return (
		a.visible === b.visible &&
		a.mode === b.mode &&
		a.notchStatus === b.notchStatus &&
		a.displayPolicy === b.displayPolicy &&
		a.currentSessionId === b.currentSessionId &&
		a.pillSnapshot.phase === b.pillSnapshot.phase &&
		a.pillSnapshot.sessionCount === b.pillSnapshot.sessionCount &&
		a.pillSnapshot.activeSessionCount === b.pillSnapshot.activeSessionCount &&
		a.pillSnapshot.pendingInteractionCount === b.pillSnapshot.pendingInteractionCount &&
		a.pillSnapshot.unreadCompletedCount === b.pillSnapshot.unreadCompletedCount &&
		a.pillSnapshot.usageWarning === b.pillSnapshot.usageWarning &&
		a.pillSnapshot.priorityTitle === b.pillSnapshot.priorityTitle &&
		sessionFingerprint(a.sessions) === sessionFingerprint(b.sessions)
	);
}

export { resetLookIslandState };
