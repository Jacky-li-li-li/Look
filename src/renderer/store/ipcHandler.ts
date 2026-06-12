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
	chatAgentNameAtom,
	forkingEntryAtomFamily,
	messagesAtomFamily,
	navigatingEntryAtomFamily,
	pendingAsksAtom,
	pendingDeleteProjectAtom,
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
			case "agent:list":
				appStore.set(agentsAtom, event.agents);
				break;

			case "agent:created":
				appStore.set(agentsAtom, [...appStore.get(agentsAtom), event.agent]);
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
				removeAgentAtoms(event.agentId);
				break;
			}

			case "agent:updated":
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agent.id ? event.agent : a)),
				);
				break;

			case "agent:model-fallback": {
				const triedCount = event.triedChain?.length ?? 0;
				const description =
					triedCount > 1 ? t("toast.triedModels", { count: triedCount, resolved: event.resolved }) : undefined;
				toast.warning(t("toast.modelUnavailable", { primary: event.primary, resolved: event.resolved }), {
					description,
					duration: 5000,
				});
				break;
			}

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

			case "permission:ask": {
				appStore.set(pendingAsksAtom, [
					...appStore.get(pendingAsksAtom),
					{
						requestId: event.requestId,
						agentId: event.agentId,
						toolName: event.toolName,
						args: event.args,
						reason: event.reason,
					},
				]);
				break;
			}

			case "permission:resolved": {
				const asks = appStore.get(pendingAsksAtom);
				const resolved = asks.find((ask) => ask.requestId === event.requestId);
				appStore.set(
					pendingAsksAtom,
					asks.filter((ask) => ask.requestId !== event.requestId),
				);
				if (resolved && event.decision.action === "deny" && event.decision.reason.startsWith("Timed out")) {
					toast(t("permission.timedOut", { toolName: resolved.toolName }), {
						description: resolved.reason,
						duration: 3000,
					});
				}
				break;
			}

			case "agent:permission-mode": {
				appStore.set(
					agentsAtom,
					appStore.get(agentsAtom).map((a) => (a.id === event.agentId ? { ...a, permissionMode: event.mode } : a)),
				);
				toast.success(t("toast.permissionMode", { mode: event.mode }), { duration: 1500 });
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
					id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

let _lastActiveAgentId: string | null = null;

/** Try lastActiveAgentId first, then first chat agent. */
function _autoSelectAgent(): void {
	if (appStore.get(activeAgentIdAtom)) return;
	const agents = appStore.get(agentsAtom);
	if (agents.length === 0) return;
	if (_lastActiveAgentId && agents.some((a) => a.id === _lastActiveAgentId)) {
		appStore.set(activeAgentIdAtom, _lastActiveAgentId);
		return;
	}
	const chatAgent = agents.find((a) => a.role === "chat");
	if (chatAgent) {
		appStore.set(activeAgentIdAtom, chatAgent.id);
	}
}

/** Initialize data previously loaded in App.tsx's useEffect hooks. */
export async function initAppData(api: any): Promise<void> {
	// 1. Fetch provider settings once at boot (fire-and-forget).
	api.getSettings()
		.then((r: any) => {
			if (r?.success) appStore.set(providerSettingsAtom, r.providers);
		})
		.catch(() => {});

	// 2. Load persisted general settings (fire-and-forget).
	api.getGeneralSettings()
		.then((r: any) => {
			if (r?.success && r.settings) {
				if (r.settings.language) i18n.changeLanguage(r.settings.language);
				if (r.settings.autoCollapse !== undefined) appStore.set(autoCollapseAtom, r.settings.autoCollapse);
				if (r.settings.chatAgentName !== undefined) appStore.set(chatAgentNameAtom, r.settings.chatAgentName);
				if (r.settings.preferredModel) appStore.set(userPreferredModelAtom, r.settings.preferredModel);
				if (r.settings.lastActiveAgentId) {
					_lastActiveAgentId = r.settings.lastActiveAgentId;
				}
			}
		})
		.catch(() => {});

	// 3. Pull initial project list.
	api.listProjects()
		.then((r: any) => {
			if (r?.success && Array.isArray(r.projects)) {
				appStore.set(projectsAtom, r.projects);
				if (r.activeProjectId) appStore.set(activeProjectIdAtom, r.activeProjectId);
			}
		})
		.catch(() => {});

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
