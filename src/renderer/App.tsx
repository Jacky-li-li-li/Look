// ============================================================
// App — Ink Wash Design System (shadcn/ui)
// ============================================================

import type {
	AgentInfo,
	MainToRendererEvent,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiThinkingBlock,
	PiToolCallBlock,
	ThinkingLevel,
} from "@shared/types";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { showError } from "./lib/ipc";

interface SettingsProviderInfo {
	id: string;
	name: string;
	hasKey: boolean;
	envVar: string;
	modelsAvailable: number;
}

import { Button } from "@shared/components/ui/button";
import { Separator } from "@shared/components/ui/separator";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import AgentCreateDialog from "./components/AgentCreateDialog";
import ChatPanel from "./components/ChatPanel";
import { PermissionDialog, type PermissionRequest } from "./components/PermissionDialog";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import SettingsDialog from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";

const api = (window as any).look;

export default function App() {
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Record<string, PiMessage[]>>({});
	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [defaultModelForCreate, setDefaultModelForCreate] = useState<string | undefined>(undefined);
	const [showSettings, setShowSettings] = useState(false);
	const [settingsTab, setSettingsTab] = useState<"general" | "api-keys" | "chat-prompt" | "about">("general");
	// Cached provider settings — fetched once at app boot, not on each Settings open.
	// Hoisting this out of SettingsDialog avoids the IPC + main-process model-registry
	// walk (~16k line static list) on every dialog mount.
	const [providerSettings, setProviderSettings] = useState<SettingsProviderInfo[]>([]);
	// Permission dialog queue. The head is shown; the rest are
	// hidden until the head is decided (or times out).
	const [pendingAsks, setPendingAsks] = useState<PermissionRequest[]>([]);
	const pendingAsk = pendingAsks[0] ?? null;
	const pendingQueueDepth = pendingAsks.length;
	// Per-agent SDK queue snapshot. Driven by `agent:queue_update`
	// events emitted by the main process (which in turn is
	// mirroring pi SDK's internal _steeringMessages /
	// _followUpMessages). The ChatPanel reads this for the
	// "Queued" drawer instead of maintaining its own fake
	// queue state — that way the drawer survives agent
	// switches, app restarts (via the persisted snapshot), and
	// aborts (via session.clearQueue() → queue_update).
	const [queues, setQueues] = useState<Record<string, { steering: string[]; followUp: string[] }>>({});
	// The model the user most recently picked in the bottom-bar
	// ModelSelector. Persisted in-memory only (lost on reload —
	// v1.5 will move this into user-settings.ts).
	// Used by handleQuickCreateChat as the default for a new
	// chat-mode agent so newly-spawned sessions follow the user's
	// current pick without an extra "choose a model" step.
	const [userPreferredModel, setUserPreferredModel] = useState<string | null>(null);

	// Live handle to the currently selected agent. The event listener
	// below captures this ref so the switch-case handler always sees
	// the latest activeAgentId even though onEvent is registered
	// exactly once. Pre-P2-1, the useEffect included activeAgentId in
	// its deps, which tore down and rebuilt the IPC subscription on
	// every agent switch — both a perf hit and a stale-closure risk
	// (the old callback could route events to a deleted agent).
	const activeAgentIdRef = useRef<string | null>(null);
	useEffect(() => {
		activeAgentIdRef.current = activeAgentId;
	}, [activeAgentId]);
	// ↑ a tiny inline hook to mirror state → ref.

	useEffect(() => {
		if (!api) {
			toast.error("Harness API not available. Run in Electron.");
			return;
		}

		// P2-1: register the IPC subscription exactly once. The handler
		// reads the current activeAgentId through `activeAgentIdRef` so
		// it never holds a stale closure over state. Pre-P2-1 this
		// effect re-ran on every activeAgentId change, tearing down and
		// rebuilding the subscription and risking event loss.
		const unsub = api.onEvent((event: MainToRendererEvent) => {
			switch (event.type) {
				// ---- Look-specific list / status events ----
				case "agent:list":
					setAgents(event.agents);
					break;
				case "agent:created":
					setAgents((prev) => [...prev, event.agent]);
					break;
				case "agent:destroyed":
					setAgents((prev) => prev.filter((a) => a.id !== event.agentId));
					// Use the ref (latest) instead of the closure-captured
					// activeAgentId — see the activeAgentIdRef comment above.
					if (activeAgentIdRef.current === event.agentId) setActiveAgentId(null);
					break;
				case "agent:updated":
					setAgents((prev) => prev.map((a) => (a.id === event.agent.id ? event.agent : a)));
					break;
				case "agent:model-fallback": {
					// The user asked for an explicit, non-ambiguous signal when
					// the primary model was unavailable and a fallback kicked in.
					// Show as a warning toast (sonner) — distinct from error
					// toasts so the user can tell "fell back successfully"
					// from "switch failed".
					const triedCount = event.triedChain?.length ?? 0;
					const description =
						triedCount > 1 ? `Tried ${triedCount} models in chain. Now using ${event.resolved}.` : undefined;
					toast.warning(`Model unavailable: ${event.primary}. Switched to ${event.resolved}.`, {
						description,
						duration: 5000,
					});
					break;
				}
				case "agent:status":
					setAgents((prev) => prev.map((a) => (a.id === event.agentId ? { ...a, status: event.status } : a)));
					break;
				case "agent:usage-update":
					setAgents((prev) => prev.map((a) => (a.id === event.agentId ? { ...a, usage: event.usage } : a)));
					break;
				case "agent:history": {
					setMessages((prev) => ({ ...prev, [event.agentId]: event.messages }));
					break;
				}
				case "permission:ask": {
					// Real pre-execution gate: pi is suspended on this ask.
					// Queue it (renderer shows one at a time).
					setPendingAsks((prev) => [
						...prev,
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
				case "agent:permission-mode": {
					// Sync the agent's permission mode from main.
					setAgents((prev) =>
						prev.map((a) => (a.id === event.agentId ? { ...a, permissionMode: event.mode } : a)),
					);
					toast(`Permission mode: ${event.mode}`, { duration: 1500 });
					break;
				}
				case "agent:queue_update": {
					// SDK-authoritative queue snapshot. The main process
					// forwards this from pi's _emitQueueUpdate(); the SDK
					// itself mutates the queue on prompt-with-streaming,
					// steer, followUp, and clearQueue. We snapshot the
					// arrays so React re-renders on every change.
					setQueues((prev) => ({
						...prev,
						[event.agentId]: {
							steering: [...event.steering],
							followUp: [...event.followUp],
						},
					}));
					break;
				}
				case "error": {
					toast.error(event.agentId ? `[${event.agentId.slice(0, 6)}] ${event.message}` : event.message, {
						duration: 5000,
					});
					break;
				}

				// ---- pi session events (mirrored with `agent:` prefix) ----
				// pi's `message_start` carries the full message object; the
				// main process also adds the message to its local store
				// (see `handleLookSideEffect`). Renderer just appends.
				case "agent:message_start": {
					const msg = event.message as any; // raw pi SDK message pass-through
					setMessages((prev) => {
						const msgs = [...(prev[event.agentId] ?? [])];
						const makeContentBlocks = (content: unknown): PiContentBlock[] => {
							if (Array.isArray(content)) {
								return content.map((b: any): PiContentBlock => {
									if (b.type === "toolCall") {
										return {
											type: "toolCall",
											id: b.id ?? "",
											name: b.name ?? "unknown",
											arguments: b.arguments ?? {},
											status: "pending",
											result: "",
											isError: false,
										} satisfies PiToolCallBlock;
									}
									return { ...b, active: true } as PiTextBlock | PiThinkingBlock;
								});
							}
							if (typeof content === "string" && content.length > 0) {
								return [{ type: "text", text: content, active: false }];
							}
							return [];
						};
						const ui: PiMessage = {
							id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
							agentId: event.agentId,
							role: msg.role === "toolResult" ? "tool" : (msg.role ?? "assistant"),
							contentBlocks: makeContentBlocks(msg.content),
							timestamp: msg.timestamp ?? Date.now(),
							isStreaming: true,
						};
						msgs.push(ui);
						return { ...prev, [event.agentId]: msgs };
					});
					break;
				}
				case "agent:message_update": {
					// pi's `message_update` carries a delta in `assistantMessageEvent`.
					// We apply it to the matching streaming message's contentBlocks.
					const evt = event.assistantMessageEvent;
					setMessages((prev) => {
						const msgs = [...(prev[event.agentId] ?? [])];
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
						if (idx < 0) return prev;
						const blocks = [...msgs[idx].contentBlocks];
						if (evt.type === "text_delta") {
							let block = [...blocks].reverse().find((b) => b.type === "text" && b.active === true) as
								| PiTextBlock
								| undefined;
							if (!block) {
								block = { type: "text", text: "", active: true };
								blocks.push(block);
							}
							block.text += evt.delta;
						} else if (evt.type === "thinking_delta") {
							let block = [...blocks].reverse().find((b) => b.type === "thinking" && b.active === true) as
								| PiThinkingBlock
								| undefined;
							if (!block) {
								block = { type: "thinking", thinking: "", active: true };
								blocks.push(block);
							}
							block.thinking += evt.delta;
						} else if (evt.type === "toolcall_end") {
							const tc = (evt as any).toolCall;
							if (tc) {
								blocks.push({
									type: "toolCall",
									id: tc.id ?? "",
									name: tc.name ?? "unknown",
									arguments: tc.arguments ?? {},
									status: "pending",
									result: "",
									isError: false,
								} satisfies PiToolCallBlock);
							}
						} else if (evt.type === "text_end") {
							for (const b of blocks) if (b.type === "text" && b.active) b.active = false;
						} else if (evt.type === "thinking_end") {
							for (const b of blocks) if (b.type === "thinking" && b.active) b.active = false;
						}
						msgs[idx] = { ...msgs[idx], contentBlocks: blocks };
						return { ...prev, [event.agentId]: msgs };
					});
					break;
				}
				case "agent:message_end": {
					// Final state: replace streaming message with the completed one.
					const finalMsg = event.message as any; // raw pi SDK message pass-through
					setMessages((prev) => {
						const msgs = [...(prev[event.agentId] ?? [])];
						let idx = msgs.length - 1;
						for (let i = msgs.length - 1; i >= 0; i--)
							if (msgs[i].isStreaming) {
								idx = i;
								break;
							}
						if (idx < 0) return prev;
						const blocks: PiContentBlock[] = Array.isArray(finalMsg.content)
							? finalMsg.content.map((b: any): PiContentBlock => {
									if (b.type === "toolCall") {
										return {
											type: "toolCall",
											id: b.id ?? "",
											name: b.name ?? "unknown",
											arguments: b.arguments ?? {},
											status: "pending",
											result: "",
											isError: false,
										} satisfies PiToolCallBlock;
									}
									return { ...b, active: false } as PiTextBlock | PiThinkingBlock;
								})
							: msgs[idx].contentBlocks;
						msgs[idx] = {
							...msgs[idx],
							contentBlocks: blocks,
							isStreaming: false,
							timestamp: finalMsg.timestamp ?? msgs[idx].timestamp,
						};
						return { ...prev, [event.agentId]: msgs };
					});
					break;
				}
				case "agent:tool_execution_start":
				case "agent:tool_execution_update":
				case "agent:tool_execution_end": {
					// Mirror pi's tool-call lifecycle into the matching content block.
					setMessages((prev) => {
						const msgs = [...(prev[event.agentId] ?? [])];
						let idx = msgs.length - 1;
						for (let i = msgs.length - 1; i >= 0; i--)
							if (msgs[i].isStreaming) {
								idx = i;
								break;
							}
						if (idx < 0) return prev;
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
						return { ...prev, [event.agentId]: msgs };
					});
					break;
				}
			}
		});

		return unsub;
		// P2-1: empty deps — we want the IPC subscription to live for
		// the entire component lifetime. Per-state reads go through
		// refs (activeAgentIdRef) to avoid stale closures.
	}, []);

	useEffect(() => {
		if (!activeAgentId && agents.length > 0) {
			const chatAgent = agents.find((a) => a.role === "chat");
			if (chatAgent) {
				setActiveAgentId(chatAgent.id);
			}
			// Don't fall back to agents[0] — it could be an orchestrator,
			// which shouldn't be auto-selected for the chat tab.
		}
	}, [agents, activeAgentId]);

	// Fetch provider settings once at app boot so opening Settings is instant.
	useEffect(() => {
		if (!api) return;
		api.getSettings()
			.then((r: any) => {
				if (r?.success) setProviderSettings(r.providers);
			})
			.catch(showError);
	}, []);

	// Load the persisted "user preferred model" so the bottom-bar
	// ModelSelector and the next + New Agent can pick it up across
	// app restarts. Chat mode uses this as the seed when the active
	// agent has no model of its own.
	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r: any) => {
				if (r?.success && r.settings?.preferredModel) {
					setUserPreferredModel(r.settings.preferredModel);
				}
			})
			.catch(showError);
	}, []);

	// Pull initial agent list + restored history in a single roundtrip
	// on mount. The main process bundles agents and history in one IPC
	// response (see AgentManager.listAgentsWithHistory + ipc-handlers
	// `agents:list`) to eliminate the race that the old two-step
	// getAgents + getHistory pull suffered from under React StrictMode.
	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		api.getAgents()
			.then((r: any) => {
				if (cancelled || !r?.success) return;
				if (Array.isArray(r.agents)) setAgents(r.agents);
				if (r.history && typeof r.history === "object") {
					// Only adopt restored history for agents that the renderer
					// doesn't already have messages for. The live `agent:message`
					// push stream is the source of truth for in-flight messages.
					setMessages((prev) => {
						const next = { ...prev };
						for (const [agentId, msgs] of Object.entries(r.history)) {
							if (Array.isArray(msgs) && msgs.length > 0 && (next[agentId] ?? []).length === 0) {
								next[agentId] = msgs as PiMessage[];
							}
						}
						return next;
					});
				}
			})
			.catch(showError);
		return () => {
			cancelled = true;
		};
	}, []);

	// Permission ask: 30s default-deny timer. If the user doesn't
	// respond, the head of the queue is auto-denied (fail-closed).
	useEffect(() => {
		if (!pendingAsk) return;
		const head = pendingAsk;
		const t = setTimeout(() => {
			setPendingAsks((prev) => (prev.length > 0 && prev[0].requestId === head.requestId ? prev.slice(1) : prev));
			api.respondPermission({ action: "deny", requestId: head.requestId, reason: "Timed out (30s)" }).catch(
				() => {},
			);
			toast(`Timed out — denied: ${head.toolName}`, { description: head.reason, duration: 3000 });
		}, 30_000);
		return () => clearTimeout(t);
	}, [pendingAsk]);

	const handleSendMessage = useCallback(
		(text: string) => {
			if (!activeAgentId || !api) return;
			api.sendMessage(activeAgentId, text);
		},
		[activeAgentId],
	);

	const handleSelectAgent = useCallback((agentId: string) => setActiveAgentId(agentId), []);
	const handleCreateAgent = useCallback(
		async (name: string, role: string, model?: string, thinkingLevel?: string) => {
			if (!api) return;
			const result = await api.createAgent(name, role, model, thinkingLevel, activeAgentId);
			if (result?.success && result.agentId) setActiveAgentId(result.agentId);
			setShowCreateDialog(false);
		},
		[activeAgentId],
	);
	const handleDestroyAgent = useCallback(async (agentId: string) => {
		if (!api) return;
		await api.destroyAgent(agentId);
	}, []);
	// P2-2: Stop button handler — calls the new agent:abort IPC.
	// The agent's status naturally rolls back to idle via the SDK
	// event stream, so we don't need to optimistically update state.
	const handleAbortAgent = useCallback(async () => {
		if (!api || !activeAgentId) return;
		try {
			await api.abortAgent(activeAgentId);
		} catch (err: any) {
			toast.error(`Stop failed: ${err?.message ?? "unknown"}`);
		}
	}, [activeAgentId]);
	const handleThinkingChange = useCallback(
		async (level: string) => {
			if (!activeAgentId || !api) return;
			await api.updateThinking(activeAgentId, level);
			setAgents((prev) =>
				prev.map((a) => (a.id === activeAgentId ? { ...a, thinkingLevel: level as ThinkingLevel } : a)),
			);
		},
		[activeAgentId],
	);
	const handleModelChanged = useCallback((newModel: string) => {
		// The `agent:updated` event from main (emitted right after
		// `m.session.setModel()` + `m.info.model = modelKey`) is
		// the authoritative path for updating the agent's model in
		// `agents` state — see App.tsx's `agent:updated` handler.
		// We must NOT do a second `setAgents` here keyed on
		// `activeAgentId`: that field can drift between the
		// user's click and the IPC roundtrip's completion, and
		// the stale id would silently clobber whatever agent the
		// user has since navigated to.
		//
		// What this callback *does* own is renderer-only state
		// that the main process can't see: the user's preferred
		// model for the next quick-create, and the persisted
		// general setting.
		setUserPreferredModel(newModel); // remember for next quick-create
		// Persist across app restarts. Fire-and-forget; if the IPC
		// fails we keep the in-memory pick and try again on the
		// next switch.
		if (api) {
			api.setGeneralSettings({ preferredModel: newModel }).catch(() => {});
		}
	}, []);

	// Stable callback identities for Sidebar — prevents Sidebar re-renders
	// when other App state (e.g. showSettings) changes.
	const activeAgent = agents.find((a) => a.id === activeAgentId);
	const activeMessages = activeAgentId ? (messages[activeAgentId] ?? []) : [];

	const handleCreateClick = useCallback((defaultModel?: string) => {
		setDefaultModelForCreate(defaultModel);
		setShowCreateDialog(true);
	}, []);
	const handleSettingsClick = useCallback(() => {
		setSettingsTab("general");
		setShowSettings(true);
	}, []);
	// Opened from inside the chat panel (e.g. ModelSelector's empty
	// state) — jumps straight to the API keys tab.
	const handleRequestApiKeys = useCallback(() => {
		setSettingsTab("api-keys");
		setShowSettings(true);
	}, []);
	const handleQuickCreateChat = useCallback(async () => {
		if (!api) return;
		// Chat mode is a "blank workstation" — no role default. Pick
		// the most-specific model we can:
		//   1. the active agent's current model (inherit in-place)
		//   2. the model the user most recently picked in the bottom bar
		//   3. undefined → main process falls through to firstAvailableModelKey()
		const seedModel = activeAgent?.model ?? userPreferredModel ?? undefined;
		const r = await api.createAgent("聊天助手", "chat", seedModel, undefined, activeAgentId);
		if (r?.success && r.agentId) setActiveAgentId(r.agentId);
	}, [activeAgentId, activeAgent?.model, userPreferredModel]);
	const handleCloseSettings = useCallback(() => setShowSettings(false), []);

	// Opens the project root directory in the OS file manager (Finder).
	const handleOpenProjectFolder = useCallback(() => {
		try {
			const fn = api?.openProjectFolder;
			if (typeof fn !== "function") {
				toast.error("API not available — restart the app to reload preload.");
				return;
			}
			fn().catch((err: any) => toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`));
		} catch (err: any) {
			toast.error(`Failed to open folder: ${err?.message ?? "unknown"}`);
		}
	}, []);

	// Permission dialog — drain the head of the queue, send the
	// decision to main, and let the next ask take over. Decisions
	// are sent best-effort: a broken IPC dismisses the dialog so the
	// user isn't stranded.
	const drainAsk = useCallback(
		(action: "allow" | "deny" | "edit", extras?: { reason?: string; args?: Record<string, unknown> }) => {
			setPendingAsks((prev) => {
				if (prev.length === 0) return prev;
				const [head, ...rest] = prev;
				// Fire-and-forget — main process resolves the ask.
				api.respondPermission({ action, requestId: head.requestId, ...extras })
					.then((r: any) => {
						if (!r?.success) {
							toast.error(`Permission response failed: ${r?.error ?? "unknown"}`);
						} else if (action === "allow") {
							toast.success(`Allowed: ${head.toolName}`, { duration: 1500 });
						} else if (action === "deny") {
							toast(`Denied: ${head.toolName}`, { description: head.reason, duration: 2000 });
						} else {
							toast.success(`Allowed (edited): ${head.toolName}`, { duration: 1500 });
						}
					})
					.catch(() => toast.error("Failed to send permission response"));
				return rest;
			});
		},
		[],
	);

	const handlePermissionAllow = useCallback(() => drainAsk("allow"), [drainAsk]);
	const handlePermissionDeny = useCallback(() => drainAsk("deny"), [drainAsk]);
	const handlePermissionEdit = useCallback((args: Record<string, unknown>) => drainAsk("edit", { args }), [drainAsk]);

	// Permission mode change for the active agent.
	const handlePermissionModeChange = useCallback(
		(mode: "ask" | "plan" | "allow") => {
			if (!activeAgentId) return;
			setAgents((prev) => prev.map((a) => (a.id === activeAgentId ? { ...a, permissionMode: mode } : a)));
			api.setPermissionMode(activeAgentId, mode);
		},
		[activeAgentId],
	);

	if (!api) {
		return (
			<div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
				<PixelAgentAvatar size="lg" active />
				<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
				<p className="text-sm text-destructive">Harness API not available.</p>
				<p className="text-xs text-muted-foreground">
					Run with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">npm run dev</code> inside
					Electron.
				</p>
			</div>
		);
	}

	return (
		<ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
			<TooltipProvider>
				<div className="app-shell flex h-screen overflow-hidden bg-background p-2">
					<Sidebar
						agents={agents}
						activeAgentId={activeAgentId}
						onSelect={handleSelectAgent}
						onDestroy={handleDestroyAgent}
						onCreateClick={handleCreateClick}
						onQuickCreateChat={handleQuickCreateChat}
						onSettingsClick={handleSettingsClick}
					/>

					<Separator orientation="vertical" className="mx-2 bg-transparent" />

					<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-background">
						{activeAgent ? (
							<>
								<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-hairline px-4">
									<div className="flex min-w-0 items-center gap-3">
										<PixelAgentAvatar role={activeAgent.role} status={activeAgent.status} size="sm" active />
										<div className="min-w-0">
											<div className="flex min-w-0 items-center gap-2">
												<h1 className="truncate text-[13px] font-semibold">{activeAgent.name}</h1>
											</div>
										</div>
									</div>
									<div className="flex items-center gap-1">
										<Button
											size="icon"
											variant="ghost"
											className="size-7"
											onClick={handleOpenProjectFolder}
											aria-label="Open session storage"
											title="Open project folder"
										>
											<FolderOpen className="size-3.5" />
										</Button>
									</div>
								</header>

								<ChatPanel
									agentId={activeAgent.id}
									agentRole={activeAgent.role}
									agentName={activeAgent.name}
									messages={activeMessages}
									queue={queues[activeAgent.id] ?? { steering: [], followUp: [] }}
									agentStatus={activeAgent.status}
									currentModel={activeAgent.model}
									currentThinking={activeAgent.thinkingLevel}
									currentPermissionMode={activeAgent.permissionMode ?? "ask"}
									onSend={handleSendMessage}
									onThinkingChange={handleThinkingChange}
									onModelChange={handleModelChanged}
									onPermissionModeChange={handlePermissionModeChange}
									onRequestApiKeys={handleRequestApiKeys}
									onAbort={handleAbortAgent}
								/>
							</>
						) : (
							<div className="flex flex-1 items-center justify-center p-10 text-center">
								<div className="flex max-w-sm flex-col items-center gap-3">
									<PixelAgentAvatar size="lg" />
									<p className="text-xs text-muted-foreground">Select an agent or create one to begin.</p>
								</div>
							</div>
						)}
					</main>

					{showCreateDialog && (
						<AgentCreateDialog
							defaultModel={defaultModelForCreate}
							onCreate={handleCreateAgent}
							onClose={() => {
								setShowCreateDialog(false);
								setDefaultModelForCreate(undefined);
							}}
						/>
					)}
					{showSettings && (
						<SettingsDialog
							open={showSettings}
							providers={providerSettings}
							onProvidersChange={setProviderSettings}
							onClose={handleCloseSettings}
							defaultTab={settingsTab}
						/>
					)}

					<PermissionDialog
						request={pendingAsk}
						queueDepth={pendingQueueDepth}
						onAllow={handlePermissionAllow}
						onDeny={handlePermissionDeny}
						onEdit={handlePermissionEdit}
					/>
				</div>
			</TooltipProvider>
		</ThemeProvider>
	);
}
