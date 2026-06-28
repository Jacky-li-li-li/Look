// ============================================================
// IPC Handler — vanilla Jotai store, outside React lifecycle
// ============================================================
// All IPC events from the main process are handled here via
// `appStore.set()`, completely decoupled from React's render cycle.
// Components subscribe only to the session state they render.
// ============================================================

import {
	type AgentInfo,
	LOOK_MESSAGE_DURATION_ENTRY_TYPE,
	type LookMessageDurationEntryData,
	type LookUiEvent,
	type LookUiPhase,
	type LookUiStreamBlock,
	type LookUiToolExecState,
	type MainToRendererEvent,
	type SessionSnapshotEnvelope,
} from "@shared/types";
import { createStore } from "jotai";
import { toast } from "sonner";
import i18n from "../i18n";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	autoCollapseAtom,
	emptyPlanQuestionDraft,
	forkingEntryAtomFamily,
	loadedWorkspaceChildrenAtomFamily,
	navigatingEntryAtomFamily,
	openedSessionIdsAtom,
	openProjectIdsAtom,
	pendingDeleteProjectAtom,
	permissionAskQueueAtom,
	planApprovalRequestAtomFamily,
	planQuestionDraftAtomFamily,
	planQuestionRequestAtomFamily,
	projectsAtom,
	providerSettingsAtom,
	recentlyCompletedAtom,
	removeAgentAtoms,
	removeProjectAtoms,
	sessionLeafIdAtomFamily,
	sessionStateAtomFamily,
	sharedFilesAtomFamily,
	updateStatusAtom,
	userPreferredModelAtom,
} from "./atoms";

/** The global Jotai store — shared by IPC handler and React Provider. */
export const appStore = createStore();

/** i18n t-function — use the i18next instance directly outside React. */
const t = i18n.t.bind(i18n);

/**
 * 合并 shared:updated 事件,200ms debounce 一次 listSharedFiles。
 * 防止高频小写入(例如 agent 批量落盘)触发 IPC 风暴(M-10)。
 */
const SHARED_REFRESH_DEBOUNCE_MS = 200;
const sharedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSharedRefresh(projectId: string, filesAtom: ReturnType<typeof sharedFilesAtomFamily>): void {
	const existing = sharedRefreshTimers.get(projectId);
	if (existing) clearTimeout(existing);
	sharedRefreshTimers.set(
		projectId,
		setTimeout(() => {
			sharedRefreshTimers.delete(projectId);
			void window.look
				.listSharedFiles(projectId)
				.then((result) => {
					if (result?.success && result.nodes) {
						appStore.set(filesAtom, result.nodes);
					} else if (result && !result.success) {
						toast.error(result.error ?? "刷新共享区失败");
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : "刷新共享区失败";
					toast.error(message);
				});
		}, SHARED_REFRESH_DEBOUNCE_MS),
	);
}

function applySnapshot(snapshot: SessionSnapshotEnvelope): void {
	const previous = appStore.get(sessionStateAtomFamily(snapshot.sessionId));
	const isAgentEnd = snapshot.reason === "agent_end";

	// Load per-message durations persisted as custom entries by the main process.
	const messageDurations = { ...previous.messageDurations };
	for (const entry of snapshot.entries) {
		if (entry.type === "custom" && entry.customType === LOOK_MESSAGE_DURATION_ENTRY_TYPE) {
			const data = entry.data as LookMessageDurationEntryData | undefined;
			if (data?.entryId && data.durationMs != null && data.durationMs > 0) {
				messageDurations[data.entryId] = data.durationMs;
			}
		}
	}

	// The main process appends a duration custom entry as the leaf after a turn.
	// Treat the assistant message it belongs to as the active leaf for the UI.
	let leafId = snapshot.leafId;
	if (leafId) {
		const leafEntry = snapshot.entries.find((entry) => entry.id === leafId);
		if (leafEntry?.type === "custom" && leafEntry.customType === LOOK_MESSAGE_DURATION_ENTRY_TYPE) {
			const data = leafEntry.data as LookMessageDurationEntryData | undefined;
			if (data?.entryId) leafId = data.entryId;
		}
	}

	appStore.set(sessionStateAtomFamily(snapshot.sessionId), {
		...previous,
		entries: snapshot.entries,
		leafId,
		runtime: {
			...snapshot.runtime,
			steering: [...snapshot.runtime.steering],
			followUp: [...snapshot.runtime.followUp],
		},
		messageDurations,
		// Snapshots are the source of truth for persisted history. Clear any
		// live streaming state on agent_end to avoid stale blocks.
		uiBlocks: isAgentEnd ? [] : previous.uiBlocks,
		uiTools: isAgentEnd ? {} : previous.uiTools,
		uiPhase: isAgentEnd ? "idle" : previous.uiPhase,
		uiSteering: isAgentEnd ? [] : previous.uiSteering,
		uiFollowUp: isAgentEnd ? [] : previous.uiFollowUp,
		// Always clear the pending user message after a snapshot — the snapshot
		// entries are now the source of truth for message history.
		pendingUserMessage: null,
	});
	appStore.set(sessionLeafIdAtomFamily(snapshot.sessionId), leafId);
	appStore.set(navigatingEntryAtomFamily(snapshot.sessionId), null);
	appStore.set(forkingEntryAtomFamily(snapshot.sessionId), null);
	appStore.set(
		agentsAtom,
		appStore.get(agentsAtom).map((agent) =>
			agent.id === snapshot.sessionId
				? {
						...agent,
						model: snapshot.runtime.model
							? `${snapshot.runtime.model.provider}/${snapshot.runtime.model.id}`
							: agent.model,
						thinkingLevel: snapshot.runtime.thinkingLevel,
						isStreaming: snapshot.runtime.isStreaming,
						isRetrying: snapshot.runtime.isRetrying,
						isCompacting: snapshot.runtime.isCompacting,
						messageCount: snapshot.runtime.stats.totalMessages,
					}
				: agent,
		),
	);
}

/**
 * Apply a batch of discrete LookUiEvent items to the per-session UI state.
 *
 * Each event is a flat delta (text_delta, thinking_delta, etc.) — the renderer
 * simply accumulates strings and tracks block indices. No SDK types are needed.
 */
function applyUiEventBatch(sessionId: string, events: LookUiEvent[]): void {
	if (events.length === 0) return;

	const atom = sessionStateAtomFamily(sessionId);
	const prev = appStore.get(atom);

	let blocks: LookUiStreamBlock[] = [...prev.uiBlocks];
	let toolExecs: Record<string, LookUiToolExecState> = { ...prev.uiTools };
	let phase: LookUiPhase | undefined;
	let steering: string[] | undefined;
	let followUp: string[] | undefined;
	let agentFlags: Partial<AgentInfo> | undefined;
	let pendingUserMessage: { text: string } | null | undefined;

	for (const ev of events) {
		switch (ev.type) {
			case "assistant_text_start":
				blocks = [
					...blocks,
					{ contentIndex: ev.contentIndex, kind: "text", text: "", thinking: "", completed: false },
				];
				break;
			case "assistant_text_delta": {
				// Mutate in-place on the mutable copy to avoid per-delta array rebuilds.
				for (let i = 0; i < blocks.length; i++) {
					if (blocks[i]!.contentIndex === ev.contentIndex && blocks[i]!.kind === "text" && !blocks[i]!.completed) {
						blocks[i] = { ...blocks[i]!, text: blocks[i]!.text + ev.delta };
						break;
					}
				}
				break;
			}
			case "assistant_text_end": {
				for (let i = 0; i < blocks.length; i++) {
					if (blocks[i]!.contentIndex === ev.contentIndex && blocks[i]!.kind === "text" && !blocks[i]!.completed) {
						blocks[i] = { ...blocks[i]!, completed: true };
						break;
					}
				}
				break;
			}

			case "thinking_start":
				blocks = [
					...blocks,
					{ contentIndex: ev.contentIndex, kind: "thinking", text: "", thinking: "", completed: false },
				];
				break;
			case "thinking_delta": {
				for (let i = 0; i < blocks.length; i++) {
					if (blocks[i]!.contentIndex === ev.contentIndex && blocks[i]!.kind === "thinking" && !blocks[i]!.completed) {
						blocks[i] = { ...blocks[i]!, thinking: blocks[i]!.thinking + ev.delta };
						break;
					}
				}
				break;
			}
			case "thinking_end": {
				for (let i = 0; i < blocks.length; i++) {
					if (blocks[i]!.contentIndex === ev.contentIndex && blocks[i]!.kind === "thinking" && !blocks[i]!.completed) {
						blocks[i] = { ...blocks[i]!, completed: true };
						break;
					}
				}
				break;
			}

			case "toolcall_start": {
				// Only add if no incomplete toolcall block with this contentIndex exists —
				// completed blocks from a previous message may share the same contentIndex.
				const alreadyExists = blocks.some(
					(b) => b.contentIndex === ev.contentIndex && b.kind === "toolcall" && !b.completed,
				);
				if (!alreadyExists) {
					blocks = [
						...blocks,
						{
							contentIndex: ev.contentIndex,
							kind: "toolcall",
							text: "",
							thinking: "",
							toolCallId: ev.toolCallId,
							toolName: ev.toolName,
							completed: false,
						},
					];
				}
				break;
			}
			case "toolcall_arg_delta":
				break;
			case "toolcall_end": {
				// Find the incomplete (most recent) matching block — completed blocks
				// from a previous message in the same turn may share contentIndex.
				const idx = blocks.findIndex(
					(b) => b.contentIndex === ev.contentIndex && b.kind === "toolcall" && !b.completed,
				);
				if (idx >= 0) {
					const updated = { ...blocks[idx]! };
					updated.toolCallId = ev.toolCallId;
					updated.toolName = ev.toolName;
					updated.args = ev.args;
					updated.completed = true;
					blocks = [...blocks.slice(0, idx), updated, ...blocks.slice(idx + 1)];
				} else {
					blocks = [
						...blocks,
						{
							contentIndex: ev.contentIndex,
							kind: "toolcall",
							text: "",
							thinking: "",
							toolCallId: ev.toolCallId,
							toolName: ev.toolName,
							args: ev.args,
							completed: true,
						},
					];
				}
				break;
			}

			case "tool_exec_start":
				toolExecs = {
					...toolExecs,
					[ev.toolCallId]: { toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args, phase: "running" },
				};
				break;
			case "tool_exec_update":
				if (toolExecs[ev.toolCallId]) {
					toolExecs = {
						...toolExecs,
						[ev.toolCallId]: { ...toolExecs[ev.toolCallId], partialResult: ev.partialResult },
					};
				}
				break;
			case "tool_exec_end":
				if (toolExecs[ev.toolCallId]) {
					toolExecs = {
						...toolExecs,
						[ev.toolCallId]: {
							...toolExecs[ev.toolCallId],
							phase: "completed",
							result: ev.result,
							isError: ev.isError,
						},
					};
				}
				break;

			case "run_status": {
				phase = ev.status;
				if (ev.status === "streaming") {
					blocks = [];
					toolExecs = {};
				}
				agentFlags = {
					...agentFlags,
					isStreaming: ev.status === "streaming" || ev.status === "working",
					isRetrying: ev.status === "retrying",
					isCompacting: ev.status === "compacting",
				};
				break;
			}

			case "queue_update":
				steering = ev.steering;
				followUp = ev.followUp;
				break;

			case "compacting":
				phase = ev.active ? "compacting" : "idle";
				agentFlags = { ...agentFlags, isCompacting: ev.active };
				break;

			case "retry_status":
				phase = ev.status === "start" ? "retrying" : "idle";
				agentFlags = { ...agentFlags, isRetrying: ev.status === "start" };
				if (ev.status === "end" && !ev.success && ev.finalError) {
					toast.error(ev.finalError);
				}
				break;

			case "assistant_message_start":
				blocks = blocks.filter((b) => b.completed);
				break;

			case "assistant_message_end":
				blocks = blocks.map((b) => ({ ...b, completed: true }));
				break;

			case "error":
				toast.error(ev.message);
				break;

			case "user_message":
				pendingUserMessage = { text: ev.text };
				break;

			case "session_meta":
				if (ev.field === "name") {
					appStore.set(
						agentsAtom,
						appStore
							.get(agentsAtom)
							.map((agent) => (agent.id === sessionId ? { ...agent, name: ev.value as string } : agent)),
					);
				}
				break;

			default:
				break;
		}
	}

	const nextPhase = phase ?? prev.uiPhase;
	// Once the turn is no longer active, discard transient streaming state. The
	// persisted entries from the next snapshot become the source of truth.
	if (nextPhase === "idle") {
		blocks = [];
		toolExecs = {};
	}

	appStore.set(atom, {
		...prev,
		uiBlocks: blocks,
		uiTools: toolExecs,
		uiPhase: nextPhase,
		uiSteering: steering ?? prev.uiSteering,
		uiFollowUp: followUp ?? prev.uiFollowUp,
		pendingUserMessage: pendingUserMessage !== undefined ? pendingUserMessage : prev.pendingUserMessage,
	});

	if (agentFlags) {
		appStore.set(
			agentsAtom,
			appStore.get(agentsAtom).map((agent) => (agent.id === sessionId ? { ...agent, ...agentFlags } : agent)),
		);
	}
}

/** Register all IPC event listeners. Call once at app startup. */
export function initIpcHandlers(api: any): () => void {
	const unsub = api.onEvent((event: MainToRendererEvent) => {
		switch (event.type) {
			// ---- Look-specific list / status events ----
			case "agent:list": {
				const previous = appStore.get(agentsAtom);
				const otherProjects = previous.filter((agent) => agent.projectId !== event.projectId);
				const next = [...otherProjects, ...event.agents];
				appStore.set(agentsAtom, next);
				const activeId = appStore.get(activeAgentIdAtom);
				if (activeId && !next.some((agent) => agent.id === activeId)) appStore.set(activeAgentIdAtom, null);
				break;
			}

			case "agent:created":
				appStore.set(agentsAtom, [
					...appStore.get(agentsAtom).filter((agent) => agent.id !== event.agent.id),
					event.agent,
				]);
				break;

			case "agent:destroyed": {
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).filter((a) => a.id !== event.agentId),
				);
				if (appStore.get(activeAgentIdAtom) === event.agentId) {
					appStore.set(activeAgentIdAtom, null);
				}
				// Clean up recently completed tracking
				appStore.set(
					recentlyCompletedAtom,
					appStore.get(recentlyCompletedAtom).filter((id) => id !== event.agentId),
				);
				// Clean up opened sheet
				appStore.set(
					openedSessionIdsAtom,
					appStore.get(openedSessionIdsAtom).filter((id) => id !== event.agentId),
				);
				removeAgentAtoms(event.agentId);
				appStore.set(
					permissionAskQueueAtom,
					appStore.get(permissionAskQueueAtom).filter((item) => item.agentId !== event.agentId),
				);
				break;
			}

			case "agent:updated":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agent.id ? event.agent : a)),
				);
				break;

			case "session:snapshot":
				applySnapshot(event);
				break;

			case "session:ui-event":
				applyUiEventBatch(event.sessionId, event.events);
				break;

			// ---- Project events ----
			case "project:list": {
				const previousIds = new Set(appStore.get(projectsAtom).map((project) => project.id));
				appStore.set(projectsAtom, event.projects);
				const projectIds = new Set(event.projects.map((project) => project.id));
				appStore.set(
					openProjectIdsAtom,
					appStore.get(openProjectIdsAtom).filter((projectId) => projectIds.has(projectId)),
				);
				// 清理已删除项目的 per-project atom + 待触发的 debounce timer。
				// 否则 selectedSharedPathAtomFamily 持有被删项目的路径,共享区刷新
				// 定时器仍会在 200ms 后向已不存在的 projectId atom 写值。
				for (const projectId of previousIds) {
					if (!projectIds.has(projectId)) {
						removeProjectAtoms(projectId);
						const pendingTimer = sharedRefreshTimers.get(projectId);
						if (pendingTimer) {
							clearTimeout(pendingTimer);
							sharedRefreshTimers.delete(projectId);
						}
					}
				}
				if (event.activeProjectId !== undefined) {
					appStore.set(activeProjectIdAtom, event.activeProjectId);
				}
				break;
			}

			case "project:active-changed": {
				appStore.set(activeProjectIdAtom, event.projectId);
				break;
			}

			case "project:confirm-delete": {
				appStore.set(pendingDeleteProjectAtom, {
					projectId: event.projectId,
					projectName: event.projectName,
					agentCount: event.agentCount,
					runningCount: event.runningCount,
				});
				break;
			}

			case "update:checking": {
				appStore.set(updateStatusAtom, { stage: "checking" });
				break;
			}

			case "update:available": {
				appStore.set(updateStatusAtom, {
					stage: "available",
					version: event.version,
				});
				break;
			}

			case "update:not-available": {
				appStore.set(updateStatusAtom, { stage: "not-available" });
				break;
			}

			case "update:download-progress": {
				appStore.set(updateStatusAtom, {
					stage: "downloading",
					percent: event.percent,
				});
				break;
			}

			case "update:downloaded": {
				appStore.set(updateStatusAtom, {
					stage: "downloaded",
					version: event.version,
				});
				break;
			}

			case "update:error": {
				appStore.set(updateStatusAtom, {
					stage: "error",
					message: event.message,
				});
				break;
			}

			// ---- Shared area events ----
			case "shared:updated": {
				const projectId = event.projectId;
				const filesAtom = sharedFilesAtomFamily(projectId);
				// 不翻 loading 态,避免 Virtuoso 闪烁(M-2)。
				// 首次 fetch 由 RightPanel 的 useEffect 走 loading,后续 watcher
				// 事件直接覆盖已有列表即可。
				scheduleSharedRefresh(projectId, filesAtom);
				break;
			}

			case "workspace:updated": {
				const { projectId, relativePath } = event;
				// 仅当用户已展开该目录才需要 refetch(VSCode 模式:未展开目录的事件忽略)
				const loadedAtom = loadedWorkspaceChildrenAtomFamily(projectId);
				if (!appStore.get(loadedAtom).has(relativePath)) break;
				void window.look
					.listWorkspaceChildren(projectId, relativePath)
					.then((result) => {
						if (result?.success && result.nodes) {
							appStore.set(loadedAtom, (prev) => {
								const next = new Map(prev);
								next.set(relativePath, result.nodes ?? []);
								return next;
							});
						} else {
							console.error(
								`[WorkspaceTree] Watcher refresh failed for ${projectId}/${relativePath}: ${result?.error ?? "unknown error"}`,
							);
						}
					})
					.catch((err: unknown) => {
						console.error(`[WorkspaceTree] Watcher refresh exception for ${projectId}/${relativePath}:`, err);
					});
				break;
			}

			// ---- Permission events ----
			case "permission:ask": {
				const item = { ...event.event, agentId: event.agentId };
				const queue = appStore.get(permissionAskQueueAtom);
				if (!queue.some((pending) => pending.requestId === item.requestId)) {
					appStore.set(permissionAskQueueAtom, [...queue, item]);
				}
				break;
			}

			case "permission:resolved": {
				appStore.set(
					permissionAskQueueAtom,
					appStore.get(permissionAskQueueAtom).filter((item) => item.requestId !== event.requestId),
				);
				break;
			}

			case "plan:question-requested": {
				appStore.set(planQuestionRequestAtomFamily(event.agentId), event.request);
				const draft = appStore.get(planQuestionDraftAtomFamily(event.agentId));
				if (draft.requestId !== event.request.requestId) {
					appStore.set(planQuestionDraftAtomFamily(event.agentId), {
						...emptyPlanQuestionDraft(),
						requestId: event.request.requestId,
					});
				}
				break;
			}

			case "plan:question-resolved": {
				const current = appStore.get(planQuestionRequestAtomFamily(event.agentId));
				if (current?.requestId === event.requestId) {
					appStore.set(planQuestionRequestAtomFamily(event.agentId), null);
					appStore.set(planQuestionDraftAtomFamily(event.agentId), emptyPlanQuestionDraft());
				}
				break;
			}

			case "plan:approval-requested": {
				appStore.set(planApprovalRequestAtomFamily(event.agentId), event.request);
				break;
			}

			case "plan:approval-resolved": {
				const current = appStore.get(planApprovalRequestAtomFamily(event.agentId));
				if (current?.requestId === event.requestId) {
					appStore.set(planApprovalRequestAtomFamily(event.agentId), null);
				}
				break;
			}

			case "error": {
				toast.error(
					event.agentId
						? t("toast.error", { id: event.agentId.slice(0, 6), message: event.message })
						: event.message,
					{ duration: 5000 },
				);
				break;
			}
		}
	});
	return unsub;
}

// ---- App data initialization ----

let _lastActiveSessionId: string | null = null;

/** Try the persisted session first, then the newest available session. */
function _autoSelectAgent(): void {
	if (appStore.get(activeAgentIdAtom)) return;
	const agents = appStore.get(agentsAtom);
	if (agents.length === 0) return;
	let sessionId: string;
	if (_lastActiveSessionId && agents.some((a) => a.id === _lastActiveSessionId)) {
		sessionId = _lastActiveSessionId;
	} else {
		sessionId = agents[0].id;
	}
	appStore.set(activeAgentIdAtom, sessionId);
	void window.look.activateSession(sessionId);
}

/** Initialize data previously loaded in App.tsx's useEffect hooks. */
export async function initAppData(api: any): Promise<void> {
	// 1. Fetch provider settings once at boot (fire-and-forget).
	api.getSettings()
		.then((r: any) => {
			if (r?.success) {
				appStore.set(providerSettingsAtom, {
					providers: r.providers ?? [],
					customStats: r.customStats ?? { configured: 0, totalModels: 0 },
				});
			}
		})
		.catch(() => {});

	// 2. Load persisted selection before sessions so auto-selection cannot race it.
	const settingsResult = await api.getGeneralSettings().catch(() => null);
	if (settingsResult?.success && settingsResult.settings) {
		const settings = settingsResult.settings;
		if (settings.language) await i18n.changeLanguage(settings.language);
		if (settings.autoCollapse !== undefined) appStore.set(autoCollapseAtom, settings.autoCollapse);
		if (settings.preferredModel) appStore.set(userPreferredModelAtom, settings.preferredModel);
		if (settings.lastActiveSessionId) _lastActiveSessionId = settings.lastActiveSessionId;
		if (Array.isArray(settings.openProjectIds)) appStore.set(openProjectIdsAtom, settings.openProjectIds);
		if (Array.isArray(settings.openedSessionIds)) appStore.set(openedSessionIdsAtom, settings.openedSessionIds);
	}

	// 3. Pull initial project list.
	const projectResult = await api.listProjects().catch(() => null);
	if (projectResult?.success && Array.isArray(projectResult.projects)) {
		appStore.set(projectsAtom, projectResult.projects);
		if (projectResult.activeProjectId) appStore.set(activeProjectIdAtom, projectResult.activeProjectId);
	}

	// 4. Pull session summaries. Raw SDK history is loaded on activation.
	const r = await api.getAgents().catch(() => null);
	if (r?.success) {
		if (Array.isArray(r.agents)) appStore.set(agentsAtom, r.agents);
	}

	// 5. Auto-restore / fallback after agents are loaded.
	_autoSelectAgent();

	// 6. Subscribe: whenever agents change (e.g. `agent:list` IPC),
	//    re-evaluate auto-select if nothing is active.
	appStore.sub(agentsAtom, () => _autoSelectAgent());
}
