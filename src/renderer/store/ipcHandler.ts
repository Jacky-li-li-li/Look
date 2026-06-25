// ============================================================
// IPC Handler — vanilla Jotai store, outside React lifecycle
// ============================================================
// All IPC events from the main process are handled here via
// `appStore.set()`, completely decoupled from React's render cycle.
// Components subscribe only to the session state they render.
// ============================================================

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	LOOK_MESSAGE_DURATION_ENTRY_TYPE,
	type AgentSessionEvent,
	type LookMessageDurationEntryData,
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
import type { RendererToolExecutionState } from "./sessionTypes";

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

function updateAgentRuntime(
	sessionId: string,
	patch: Partial<{ isStreaming: boolean; isRetrying: boolean; isCompacting: boolean }>,
) {
	appStore.set(
		agentsAtom,
		appStore.get(agentsAtom).map((agent) => (agent.id === sessionId ? { ...agent, ...patch } : agent)),
	);
}

function applySnapshot(snapshot: SessionSnapshotEnvelope): void {
	const previous = appStore.get(sessionStateAtomFamily(snapshot.sessionId));
	const isAgentEnd = snapshot.reason === "agent_end";
	const turnDurationMs =
		isAgentEnd && previous.turnStartedAt
			? Date.now() - previous.turnStartedAt
			: previous.turnDurationMs;

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

	// Fallback: if the snapshot raced ahead of the sdk event, still record the
	// runtime on the last assistant entry so it is visible immediately.
	if (isAgentEnd && turnDurationMs != null && turnDurationMs > 0) {
		const lastAssistantEntry = [...snapshot.entries]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (lastAssistantEntry) {
			messageDurations[lastAssistantEntry.id] = turnDurationMs;
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
		currentMessageRenderId: isAgentEnd ? null : previous.currentMessageRenderId,
		lastEndedRunId: isAgentEnd ? null : previous.lastEndedRunId,
		turnStartedAt: isAgentEnd ? 0 : previous.turnStartedAt,
		turnDurationMs,
		messageDurations,
		liveMessages: isAgentEnd
			? previous.liveMessages.filter((item) => item.runId !== (previous.lastEndedRunId ?? previous.currentRunId))
			: previous.liveMessages,
		toolExecutions: isAgentEnd ? {} : previous.toolExecutions,
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

function applySdkEvent(sessionId: string, event: AgentSessionEvent): void {
	const atom = sessionStateAtomFamily(sessionId);
	const previous = appStore.get(atom);
	switch (event.type) {
		case "agent_start":
			appStore.set(atom, {
				...previous,
				currentRunId: previous.currentRunId + 1,
				currentMessageRenderId: null,
				turnStartedAt: Date.now(),
				turnDurationMs: null,
				runtime: previous.runtime ? { ...previous.runtime, isStreaming: true } : null,
			});
			updateAgentRuntime(sessionId, { isStreaming: true });
			appStore.set(
				recentlyCompletedAtom,
				appStore.get(recentlyCompletedAtom).filter((id) => id !== sessionId),
			);
			break;
		case "agent_end":
			if (!event.willRetry) {
				appStore.set(recentlyCompletedAtom, [
					...appStore.get(recentlyCompletedAtom).filter((id) => id !== sessionId),
					sessionId,
				]);
			}
			appStore.set(atom, {
				...appStore.get(atom),
				runtime: previous.runtime ? { ...previous.runtime, isStreaming: false, isRetrying: event.willRetry } : null,
				lastEndedRunId: previous.currentRunId,
				turnDurationMs: previous.turnStartedAt
					? Date.now() - previous.turnStartedAt
					: previous.turnDurationMs,
			});
			updateAgentRuntime(sessionId, { isStreaming: false, isRetrying: event.willRetry });
			break;
		case "message_start": {
			const renderId = crypto.randomUUID();
			appStore.set(atom, {
				...previous,
				currentMessageRenderId: renderId,
				turnStartedAt: event.message.role === "user" ? 0 : previous.turnStartedAt,
				turnDurationMs: event.message.role === "user" ? null : previous.turnDurationMs,
				liveMessages: [
					...previous.liveMessages,
					{ renderId, runId: previous.currentRunId, message: event.message, completed: false },
				],
			});
			break;
		}
		case "message_update": {
			const renderId = previous.currentMessageRenderId ?? crypto.randomUUID();
			const exists = previous.liveMessages.some((item) => item.renderId === renderId);
			appStore.set(atom, {
				...previous,
				currentMessageRenderId: renderId,
				liveMessages: exists
					? previous.liveMessages.map((item) =>
							item.renderId === renderId ? { ...item, message: event.message } : item,
						)
					: [
							...previous.liveMessages,
							{ renderId, runId: previous.currentRunId, message: event.message, completed: false },
						],
			});
			break;
		}
		case "message_end": {
			const renderId = previous.currentMessageRenderId ?? crypto.randomUUID();
			const exists = previous.liveMessages.some((item) => item.renderId === renderId);
			appStore.set(atom, {
				...previous,
				currentMessageRenderId: null,
				liveMessages: exists
					? previous.liveMessages.map((item) =>
							item.renderId === renderId ? { ...item, message: event.message, completed: true } : item,
						)
					: [
							...previous.liveMessages,
							{ renderId, runId: previous.currentRunId, message: event.message, completed: true },
						],
			});
			break;
		}
		case "queue_update":
			if (previous.runtime) {
				appStore.set(atom, {
					...previous,
					runtime: { ...previous.runtime, steering: [...event.steering], followUp: [...event.followUp] },
				});
			}
			break;
		case "compaction_start":
			updateAgentRuntime(sessionId, { isCompacting: true });
			if (previous.runtime)
				appStore.set(atom, { ...previous, runtime: { ...previous.runtime, isCompacting: true } });
			break;
		case "compaction_end":
			updateAgentRuntime(sessionId, { isCompacting: false });
			if (previous.runtime)
				appStore.set(atom, { ...previous, runtime: { ...previous.runtime, isCompacting: false } });
			break;
		case "auto_retry_start":
			updateAgentRuntime(sessionId, { isRetrying: true });
			if (previous.runtime)
				appStore.set(atom, {
					...previous,
					runtime: { ...previous.runtime, isRetrying: true, retryAttempt: event.attempt },
				});
			break;
		case "auto_retry_end":
			updateAgentRuntime(sessionId, { isRetrying: false });
			if (previous.runtime) appStore.set(atom, { ...previous, runtime: { ...previous.runtime, isRetrying: false } });
			if (!event.success && event.finalError) toast.error(event.finalError);
			break;
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			const existing = previous.toolExecutions[event.toolCallId];
			const next: RendererToolExecutionState =
				event.type === "tool_execution_start"
					? {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							phase: "running",
						}
					: event.type === "tool_execution_update"
						? {
								...(existing ?? {
									toolCallId: event.toolCallId,
									toolName: event.toolName,
									args: event.args,
									phase: "running" as const,
								}),
								partialResult: event.partialResult,
							}
						: {
								...(existing ?? {
									toolCallId: event.toolCallId,
									toolName: event.toolName,
									args: {},
								}),
								phase: "completed",
								result: event.result,
								isError: event.isError,
							};
			appStore.set(atom, { ...previous, toolExecutions: { ...previous.toolExecutions, [event.toolCallId]: next } });
			break;
		}
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

			case "session:sdk-event":
				applySdkEvent(event.sessionId, event.event);
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
			if (r?.success) appStore.set(providerSettingsAtom, r.providers);
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
