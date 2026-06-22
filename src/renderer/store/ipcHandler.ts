// ============================================================
// IPC Handler — vanilla Jotai store, outside React lifecycle
// ============================================================
// All IPC events from the main process are handled here via
// `appStore.set()`, completely decoupled from React's render cycle.
// Components subscribe only to the atoms they care about, so e.g.
// `agent:usage-update` only re-renders the Sidebar row, not all of
// ChatPanel.
// ============================================================

import type {
	MainToRendererEvent,
	PermissionAskEvent,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiThinkingBlock,
	PiToolCallBlock,
} from "@shared/types";
import { createStore } from "jotai";
import { toast } from "sonner";
import i18n from "../i18n";
import {
	activeAgentIdAtom,
	activeProjectIdAtom,
	agentsAtom,
	autoCollapseAtom,
	forkingEntryAtomFamily,
	messagesAtomFamily,
	navigatingEntryAtomFamily,
	openedSessionIdsAtom,
	openProjectIdsAtom,
	pendingDeleteProjectAtom,
	permissionAskEventAtom,
	permissionModeAtom,
	projectsAtom,
	providerSettingsAtom,
	queuesAtomFamily,
	recentlyCompletedAtom,
	removeAgentAtoms,
	sessionLeafIdAtomFamily,
	sessionTreeAtomFamily,
	updateStatusAtom,
	userPreferredModelAtom,
} from "./atoms";

/** Shared: convert a raw pi SDK content block to Look's PiContentBlock. */
function sdkBlockToPiBlock(b: any): PiContentBlock {
	if (b.type === "toolCall") {
		return {
			type: "toolCall",
			id: b.id ?? "",
			name: b.name ?? "unknown",
			arguments: b.arguments ?? {},
			status: b.status ?? (b.result ? (b.isError ? "error" : "success") : "pending"),
			result: b.result ?? "",
			isError: b.isError ?? false,
		} satisfies PiToolCallBlock;
	}
	return { ...b, active: false } as PiTextBlock | PiThinkingBlock;
}

/** The global Jotai store — shared by IPC handler and React Provider. */
export const appStore = createStore();

/** i18n t-function — use the i18next instance directly outside React. */
const t = i18n.t.bind(i18n);

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
				break;
			}

			case "agent:updated":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agent.id ? event.agent : a)),
				);
				break;

			case "agent:thinking_level_changed":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agentId ? { ...a, thinkingLevel: event.level } : a)),
				);
				break;

			case "agent:status":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agentId ? { ...a, status: event.status } : a)),
				);
				// Clear "recently completed" when agent starts running again
				if (event.status === "thinking" || event.status === "working") {
					const prev = appStore.get(recentlyCompletedAtom);
					if (prev.includes(event.agentId)) {
						appStore.set(
							recentlyCompletedAtom,
							prev.filter((id) => id !== event.agentId),
						);
					}
				}
				break;

			case "agent:usage-update":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agentId ? { ...a, usage: event.usage } : a)),
				);
				break;

			case "agent:history": {
				appStore.set(messagesAtomFamily(event.agentId), event.messages);
				break;
			}

			case "agent:queue_update": {
				// Copy out of the readonly array exposed by the
				// `agent:queue_update` event payload — the atom
				// owns a mutable shape (push-friendly downstream)
				// so a fresh array avoids any aliasing surprises.
				appStore.set(queuesAtomFamily(event.agentId), {
					steering: event.steering ? [...event.steering] : [],
					followUp: event.followUp ? [...event.followUp] : [],
				});
				break;
			}

			// ---- v0.4 Session tree / branching ----
			// Fired by the main process whenever the leaf moves
			// (append, navigate, label, fork). Both the tree shape
			// and the leafId arrive together so consumers can
			// decide in one render pass whether the view is on the
			// "latest" branch.
			case "agent:tree-changed": {
				appStore.set(sessionTreeAtomFamily(event.agentId), event.tree);
				appStore.set(sessionLeafIdAtomFamily(event.agentId), event.leafId);
				// Clear the in-flight flag on whichever side the
				// main process just confirmed. Whichever wasn't
				// the cause will be cleared by its own response
				// (navigateTree returns synchronously after the
				// tree-changed emit; createFork returns via the
				// invoke promise + a fresh tree-changed).
				appStore.set(navigatingEntryAtomFamily(event.agentId), null);
				appStore.set(forkingEntryAtomFamily(event.agentId), null);
				break;
			}

			// ---- Project events ----
			case "project:list": {
				appStore.set(projectsAtom, event.projects);
				const projectIds = new Set(event.projects.map((project) => project.id));
				appStore.set(
					openProjectIdsAtom,
					appStore.get(openProjectIdsAtom).filter((projectId) => projectIds.has(projectId)),
				);
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

			// ---- Permission events ----
			case "permission:ask": {
				const askEvent = (event as any).event as PermissionAskEvent;
				if (askEvent) appStore.set(permissionAskEventAtom, askEvent);
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

			case "agent:agent_end": {
				if (!event.willRetry) {
					const prev = appStore.get(recentlyCompletedAtom);
					appStore.set(recentlyCompletedAtom, [...prev.filter((id) => id !== event.agentId), event.agentId]);
				}
				break;
			}

			// ---- pi session events (mirrored with `agent:` prefix) ----
			case "agent:message_start": {
				const msg = event.message as any;
				const msgs = [...appStore.get(messagesAtomFamily(event.agentId))];
				const blocks: PiContentBlock[] = Array.isArray(msg.content)
					? msg.content.map(sdkBlockToPiBlock)
					: typeof msg.content === "string" && msg.content.length > 0
						? [{ type: "text", text: msg.content, active: false } satisfies PiTextBlock]
						: [];
				const ui: PiMessage = {
					// v0.7: Drop fallback ID. The main process always passes msg.id from the SDK.
					id: msg.id,
					agentId: event.agentId,
					role: msg.role === "toolResult" ? "tool" : (msg.role ?? "assistant"),
					contentBlocks: blocks,
					timestamp: msg.timestamp ?? Date.now(),
					isStreaming: true,
				};
				msgs.push(ui);
				appStore.set(messagesAtomFamily(event.agentId), msgs);
				break;
			}

			case "agent:message_update": {
				const msgs = [...appStore.get(messagesAtomFamily(event.agentId))];
				const msgId = (event.message as any)?.id;
				let idx = msgId ? msgs.findIndex((m) => m.id === msgId) : -1;
				if (idx < 0) {
					idx = msgs.length - 1;
					for (let i = msgs.length - 1; i >= 0; i--)
						if (msgs[i].isStreaming) {
							idx = i;
							break;
						}
				}
				if (idx < 0) break;
				const rawContent = (event.message as any)?.content;
				if (!Array.isArray(rawContent)) break;
				msgs[idx] = { ...msgs[idx], contentBlocks: rawContent.map(sdkBlockToPiBlock) };
				appStore.set(messagesAtomFamily(event.agentId), msgs);
				break;
			}

			case "agent:message_end": {
				const finalMsg = event.message as any;
				const msgs = [...appStore.get(messagesAtomFamily(event.agentId))];
				const finalId = finalMsg?.id;
				let idx = finalId ? msgs.findIndex((m) => m.id === finalId) : -1;
				if (idx < 0) {
					for (let i = msgs.length - 1; i >= 0; i--) {
						if (msgs[i].isStreaming) {
							idx = i;
							break;
						}
					}
				}
				if (idx < 0) break;
				const oldBlocks = msgs[idx].contentBlocks;
				const blocks: PiContentBlock[] = Array.isArray(finalMsg.content)
					? finalMsg.content.map((b: any): PiContentBlock => {
							if (b.type !== "toolCall") return { ...b, active: false } as PiTextBlock | PiThinkingBlock;
							const oldBlock = oldBlocks.find(
								(ob) => ob.type === "toolCall" && (ob as PiToolCallBlock).id === b.id,
							) as PiToolCallBlock | undefined;
							return {
								type: "toolCall",
								id: b.id ?? "",
								name: b.name ?? "unknown",
								arguments: b.arguments ?? {},
								status: oldBlock?.status ?? "pending",
								result: oldBlock?.result ?? "",
								isError: oldBlock?.isError ?? false,
							} satisfies PiToolCallBlock;
						})
					: oldBlocks;
				const usage = finalMsg.usage
					? {
							inputTokens: finalMsg.usage.input ?? 0,
							outputTokens: finalMsg.usage.output ?? 0,
							cacheReadTokens: finalMsg.usage.cacheRead ?? 0,
							cacheWriteTokens: finalMsg.usage.cacheWrite ?? 0,
							totalTokens: finalMsg.usage.totalTokens ?? 0,
							cost: {
								input: finalMsg.usage.cost?.input ?? 0,
								output: finalMsg.usage.cost?.output ?? 0,
								cacheRead: finalMsg.usage.cost?.cacheRead ?? 0,
								cacheWrite: finalMsg.usage.cost?.cacheWrite ?? 0,
								total: finalMsg.usage.cost?.total ?? 0,
							},
						}
					: undefined;
				msgs[idx] = {
					...msgs[idx],
					id: finalId ?? msgs[idx].id,
					contentBlocks: blocks,
					isStreaming: false,
					timestamp: finalMsg.timestamp ?? msgs[idx].timestamp,
					usage,
				};
				appStore.set(messagesAtomFamily(event.agentId), msgs);
				break;
			}

			case "agent:tool_execution_start":
			case "agent:tool_execution_update":
			case "agent:tool_execution_end": {
				const msgs = [...appStore.get(messagesAtomFamily(event.agentId))];
				let idx = msgs.length - 1;
				for (let i = msgs.length - 1; i >= 0; i--)
					if (msgs[i].isStreaming) {
						idx = i;
						break;
					}
				if (idx < 0) break;
				const blocks = [...msgs[idx].contentBlocks];
				const callId = event.toolCallId;
				const foundIdx = blocks.findIndex((b) => b.type === "toolCall" && b.id === callId);
				if (event.type === "agent:tool_execution_start") {
					if (foundIdx < 0) {
						blocks.push({
							type: "toolCall",
							id: callId,
							name: event.toolName,
							arguments: event.args ?? {},
							status: "running",
							result: "",
							isError: false,
						} satisfies PiToolCallBlock);
					} else {
						(blocks[foundIdx] as PiToolCallBlock).status = "running";
					}
				} else if (event.type === "agent:tool_execution_update") {
					const partial = (event.partialResult as any)?.content?.[0]?.text ?? "";
					if (foundIdx >= 0) {
						const b = blocks[foundIdx] as PiToolCallBlock;
						blocks[foundIdx] = { ...b, result: (b.result ?? "") + partial };
					}
				} else {
					// tool_execution_end
					const resultStr =
						typeof event.result === "string"
							? event.result
							: ((event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result));
					if (foundIdx >= 0) {
						blocks[foundIdx] = {
							...blocks[foundIdx],
							status: event.isError ? "error" : "success",
							result: resultStr,
							isError: event.isError,
						} as PiToolCallBlock;
					} else {
						blocks.push({
							type: "toolCall",
							id: callId,
							name: event.toolName,
							arguments: {},
							status: event.isError ? "error" : "success",
							result: resultStr,
							isError: event.isError,
						} satisfies PiToolCallBlock);
					}
				}
				msgs[idx] = { ...msgs[idx], contentBlocks: blocks };
				appStore.set(messagesAtomFamily(event.agentId), msgs);
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
	if (_lastActiveSessionId && agents.some((a) => a.id === _lastActiveSessionId)) {
		appStore.set(activeAgentIdAtom, _lastActiveSessionId);
		return;
	}
	appStore.set(activeAgentIdAtom, agents[0].id);
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
			if (settings.permissionMode) appStore.set(permissionModeAtom, settings.permissionMode);
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

	// 4. Pull initial agent list + restored history synchronously.
	const r = await api.getAgents().catch(() => null);
	if (r?.success) {
		if (Array.isArray(r.agents)) appStore.set(agentsAtom, r.agents);
		if (r.history && typeof r.history === "object") {
			for (const [agentId, msgs] of Object.entries(r.history)) {
				if (Array.isArray(msgs) && msgs.length > 0) {
					const existing = appStore.get(messagesAtomFamily(agentId));
					if (existing.length === 0) {
						appStore.set(messagesAtomFamily(agentId), msgs as any);
					}
				}
			}
		}
	}

	// 5. Auto-restore / fallback after agents are loaded.
	_autoSelectAgent();

	// 6. Subscribe: whenever agents change (e.g. `agent:list` IPC),
	//    re-evaluate auto-select if nothing is active.
	appStore.sub(agentsAtom, () => _autoSelectAgent());
}
