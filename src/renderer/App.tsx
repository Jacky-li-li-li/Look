// ============================================================
// App — Ink Wash Design System (shadcn/ui)
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { cn } from "@shared/lib/utils";
import type { AgentInfo, AgentMessage, MainToRendererEvent, ThinkingLevel, ToolCallRecord } from "@shared/types";

interface SettingsProviderInfo {
  id: string; name: string; hasKey: boolean; envVar: string; modelsAvailable: number;
}
import { ThemeProvider } from "next-themes";
import { Separator } from "@shared/components/ui/separator";
import { Badge } from "@shared/components/ui/badge";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import AgentCreateDialog from "./components/AgentCreateDialog";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import SettingsDialog from "./components/SettingsDialog";
import { PermissionDialog, type PermissionRequest } from "./components/PermissionDialog";

const api = (window as any).look;

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, AgentMessage[]>>({});
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [defaultModelForCreate, setDefaultModelForCreate] = useState<string | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "api-keys" | "about">("general");
  // Cached provider settings — fetched once at app boot, not on each Settings open.
  // Hoisting this out of SettingsDialog avoids the IPC + main-process model-registry
  // walk (~16k line static list) on every dialog mount.
  const [providerSettings, setProviderSettings] = useState<SettingsProviderInfo[]>([]);
  // Permission dialog queue. The head is shown; the rest are
  // hidden until the head is decided (or times out).
  const [pendingAsks, setPendingAsks] = useState<PermissionRequest[]>([]);
  const pendingAsk = pendingAsks[0] ?? null;
  const pendingQueueDepth = pendingAsks.length;
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
  useEffect(() => { activeAgentIdRef.current = activeAgentId; }, [activeAgentId]);
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
          setAgents(prev => [...prev, event.agent]);
          break;
        case "agent:destroyed":
          setAgents(prev => prev.filter(a => a.id !== event.agentId));
          // Use the ref (latest) instead of the closure-captured
          // activeAgentId — see the activeAgentIdRef comment above.
          if (activeAgentIdRef.current === event.agentId) setActiveAgentId(null);
          break;
        case "agent:updated":
          setAgents(prev => prev.map(a => a.id === event.agent.id ? event.agent : a));
          break;
        case "agent:model-fallback": {
          // The user asked for an explicit, non-ambiguous signal when
          // the primary model was unavailable and a fallback kicked in.
          // Show as a warning toast (sonner) — distinct from error
          // toasts so the user can tell "fell back successfully"
          // from "switch failed".
          const triedCount = event.triedChain?.length ?? 0;
          const description = triedCount > 1
            ? `Tried ${triedCount} models in chain. Now using ${event.resolved}.`
            : undefined;
          toast.warning(
            `Model unavailable: ${event.primary}. Switched to ${event.resolved}.`,
            { description, duration: 5000 },
          );
          break;
        }
        case "agent:status":
          setAgents(prev => prev.map(a => a.id === event.agentId ? { ...a, status: event.status } : a));
          break;
        case "agent:usage-update":
          setAgents(prev => prev.map(a => a.id === event.agentId ? { ...a, usage: event.usage } : a));
          break;
        case "agent:history": {
          setMessages((prev) => ({ ...prev, [event.agentId]: event.messages }));
          break;
        }
        case "permission:ask": {
          // Real pre-execution gate: pi is suspended on this ask.
          // Queue it (renderer shows one at a time).
          setPendingAsks(prev => [...prev, {
            requestId: event.requestId,
            agentId: event.agentId,
            toolName: event.toolName,
            args: event.args,
            reason: event.reason,
          }]);
          break;
        }
        case "agent:permission-mode": {
          // Sync the agent's permission mode from main.
          setAgents(prev => prev.map(a => a.id === event.agentId ? { ...a, permissionMode: event.mode } : a));
          toast(`Permission mode: ${event.mode}`, { duration: 1500 });
          break;
        }
        case "error": {
          toast.error(event.agentId ? `[${event.agentId.slice(0, 6)}] ${event.message}` : event.message, { duration: 5000 });
          break;
        }

        // ---- pi session events (mirrored with `agent:` prefix) ----
        // pi's `message_start` carries the full message object; the
        // main process also adds the message to its local store
        // (see `handleLookSideEffect`). Renderer just appends.
        case "agent:message_start": {
          const msg = event.message as any; // pi AgentMessage is a discriminated union
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            // Map pi's message to UI shape (id, agentId, role, content, thinking, toolCalls, timestamp, isStreaming).
            const ui: AgentMessage = {
              id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              agentId: event.agentId,
              role: msg.role ?? "assistant",
              content: extractText(msg.content),
              thinking: extractThinking(msg.content),
              toolCalls: extractToolCalls(msg.content),
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
          // We apply it to the matching streaming message in the store.
          const evt = event.assistantMessageEvent;
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            // Find the streaming message (pi sends message.id when available)
            const msgId = (event.message as any)?.id;
            let idx = msgId ? msgs.findIndex(m => m.id === msgId) : -1;
            if (idx < 0) {
              // Fallback: last streaming message
              idx = msgs.length - 1;
              for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].isStreaming) { idx = i; break; }
            }
            if (idx < 0) return prev;
            if (evt.type === "text_delta") {
              msgs[idx] = { ...msgs[idx], content: (msgs[idx].content ?? "") + evt.delta };
            } else if (evt.type === "thinking_delta") {
              msgs[idx] = { ...msgs[idx], thinking: (msgs[idx].thinking ?? "") + evt.delta };
            } else if (evt.type === "toolcall_end") {
              const tc = (evt as any).toolCall;
              if (tc) {
                const newTc: ToolCallRecord = {
                  callId: tc.id ?? "", toolName: tc.name ?? "unknown",
                  args: tc.arguments ?? {}, status: "success", result: "", isError: false,
                };
                msgs[idx] = { ...msgs[idx], toolCalls: [...(msgs[idx].toolCalls ?? []), newTc] };
              }
            }
            return { ...prev, [event.agentId]: msgs };
          });
          break;
        }
        case "agent:message_end": {
          // Final state: replace streaming message with the completed one.
          const finalMsg = event.message as any;
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            const idx = msgs.length - 1;
            for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].isStreaming) { break; }
            if (idx < 0) return prev;
            msgs[idx] = {
              ...msgs[idx],
              content: extractText(finalMsg.content),
              thinking: extractThinking(finalMsg.content),
              toolCalls: extractToolCalls(finalMsg.content),
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
          // Mirror pi's tool-call lifecycle into the UI's toolCalls list.
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            const idx = msgs.length - 1;
            for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].isStreaming) break;
            if (idx < 0) return prev;
            const existing = msgs[idx].toolCalls ?? [];
            const callId = event.toolCallId;
            const newCalls = [...existing];
            const foundIdx = newCalls.findIndex(tc => tc.callId === callId);
            if (event.type === "agent:tool_execution_start") {
              if (foundIdx < 0) {
                newCalls.push({
                  callId, toolName: event.toolName, args: event.args ?? {},
                  status: "running", result: "", isError: false,
                });
              } else {
                newCalls[foundIdx] = { ...newCalls[foundIdx], status: "running" };
              }
            } else if (event.type === "agent:tool_execution_update") {
              const partial = (event.partialResult as any)?.content?.[0]?.text ?? "";
              if (foundIdx >= 0) {
                newCalls[foundIdx] = { ...newCalls[foundIdx], result: (newCalls[foundIdx].result ?? "") + partial };
              }
            } else {
              // tool_execution_end
              const resultStr = typeof event.result === "string"
                ? event.result
                : (event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result);
              if (foundIdx >= 0) {
                newCalls[foundIdx] = {
                  ...newCalls[foundIdx], status: event.isError ? "error" : "success",
                  result: resultStr, isError: event.isError,
                };
              } else {
                newCalls.push({ callId, toolName: event.toolName, args: {}, status: event.isError ? "error" : "success", result: resultStr, isError: event.isError });
              }
            }
            msgs[idx] = { ...msgs[idx], toolCalls: newCalls };
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
      const chatAgent = agents.find(a => a.role === "chat");
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
      .then((r: any) => { if (r?.success) setProviderSettings(r.providers); })
      .catch(() => {});
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
      .catch(() => {});
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
                next[agentId] = msgs;
              }
            }
            return next;
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Permission ask: 30s default-deny timer. If the user doesn't
  // respond, the head of the queue is auto-denied (fail-closed).
  useEffect(() => {
    if (!pendingAsk) return;
    const head = pendingAsk;
    const t = setTimeout(() => {
      setPendingAsks(prev => prev.length > 0 && prev[0].requestId === head.requestId ? prev.slice(1) : prev);
      api.respondPermission({ action: "deny", requestId: head.requestId, reason: "Timed out (30s)" })
        .catch(() => {});
      toast(`Timed out — denied: ${head.toolName}`, { description: head.reason, duration: 3000 });
    }, 30_000);
    return () => clearTimeout(t);
  }, [pendingAsk]);

  const handleSendMessage = useCallback((text: string) => {
    if (!activeAgentId || !api) return;
    api.sendMessage(activeAgentId, text);
  }, [activeAgentId]);

  const handleSelectAgent = useCallback((agentId: string) => setActiveAgentId(agentId), []);
  const handleCreateAgent = useCallback(async (name: string, role: string, model?: string, thinkingLevel?: string) => {
    if (!api) return;
    const result = await api.createAgent(name, role, model, thinkingLevel, activeAgentId);
    if (result?.success && result.agentId) setActiveAgentId(result.agentId);
    setShowCreateDialog(false);
  }, [activeAgentId]);
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
  }, [activeAgentId, api]);
  const handleThinkingChange = useCallback(async (level: string) => {
    if (!activeAgentId || !api) return;
    await api.updateThinking(activeAgentId, level);
    setAgents(prev => prev.map(a => a.id === activeAgentId ? { ...a, thinkingLevel: level as ThinkingLevel } : a));
  }, [activeAgentId]);
  const handleModelChanged = useCallback((newModel: string) => {
    setUserPreferredModel(newModel);  // remember for next quick-create
    setAgents(prev => prev.map(a => a.id === activeAgentId ? { ...a, model: newModel } : a));
    // Persist across app restarts. Fire-and-forget; if the IPC fails
    // we keep the in-memory pick and try again on the next switch.
    if (api) {
      api.setGeneralSettings({ preferredModel: newModel }).catch(() => {});
    }
  }, [activeAgentId, api]);

  // Stable callback identities for Sidebar — prevents Sidebar re-renders
  // when other App state (e.g. showSettings) changes.
  const activeAgent = agents.find(a => a.id === activeAgentId);
  const activeMessages = activeAgentId ? messages[activeAgentId] ?? [] : [];

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
    const r = await api.createAgent(
      "聊天助手",
      "chat",
      seedModel,
      undefined,
      activeAgentId,
    );
    if (r?.success && r.agentId) setActiveAgentId(r.agentId);
  }, [activeAgentId, activeAgent?.model, userPreferredModel]);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  // Permission dialog — drain the head of the queue, send the
  // decision to main, and let the next ask take over. Decisions
  // are sent best-effort: a broken IPC dismisses the dialog so the
  // user isn't stranded.
  const drainAsk = useCallback((action: "allow" | "deny" | "edit", extras?: { reason?: string; args?: Record<string, unknown> }) => {
    setPendingAsks(prev => {
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
  }, []);

  const handlePermissionAllow = useCallback(() => drainAsk("allow"), [drainAsk]);
  const handlePermissionDeny = useCallback(() => drainAsk("deny"), [drainAsk]);
  const handlePermissionEdit = useCallback((args: Record<string, unknown>) => drainAsk("edit", { args }), [drainAsk]);

  // Permission mode change for the active agent.
  const handlePermissionModeChange = useCallback((mode: "ask" | "plan" | "allow") => {
    if (!activeAgentId) return;
    setAgents(prev => prev.map(a => a.id === activeAgentId ? { ...a, permissionMode: mode } : a));
    api.setPermissionMode(activeAgentId, mode);
  }, [activeAgentId]);

  if (!api) {
    return (
      <div className="app-shell flex h-screen flex-col items-center justify-center gap-4 p-10 text-center">
        <PixelAgentAvatar size="lg" active />
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
        <p className="text-sm text-destructive">Harness API not available.</p>
        <p className="text-xs text-muted-foreground">
          Run with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">npm run dev</code> inside Electron.
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
                      <StatusBadge status={activeAgent.status} />
                    </div>
                  </div>
                </div>
              </header>

              <ChatPanel
                agentId={activeAgent.id}
                agentRole={activeAgent.role}
                agentName={activeAgent.name}
                messages={activeMessages}
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

// ── Helpers ──

function StatusBadge({ status }: { status: string }) {
  const variant = status === "error" ? "destructive" : "outline";
  return (
    <Badge variant={variant as any} className={cn("h-5 gap-1 rounded-md px-1.5 font-mono text-[9px] uppercase tracking-wider")}>
      <span className="status-mark" data-status={status} />
      {status}
    </Badge>
  );
}

// ── pi message content-block extractors ──
// pi stores AssistantMessage.content as `[{ type: "text", text }, { type: "thinking", thinking }, { type: "toolCall", ... }]`.
// The UI's AgentMessage wants plain strings + a toolCalls list.

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("");
  }
  return "";
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "thinking").map((b: any) => b.thinking ?? "").join("");
}

function extractToolCalls(content: unknown): ToolCallRecord[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "toolCall")
    .map((b: any) => ({
      callId: b.id ?? "",
      toolName: b.name ?? "unknown",
      args: b.arguments ?? {},
      status: "success" as const,
      result: "",
      isError: false,
    }));
}

