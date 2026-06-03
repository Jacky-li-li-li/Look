// ============================================================
// App — Ink Wash Design System (shadcn/ui)
// ============================================================

import React, { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { cn } from "@shared/lib/utils";
import type { AgentInfo, AgentMessage, MainToRendererEvent, ThinkingLevel } from "@shared/types";
import { Separator } from "@shared/components/ui/separator";
import { Badge } from "@shared/components/ui/badge";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import AgentCreateDialog from "./components/AgentCreateDialog";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";
import SettingsDialog from "./components/SettingsDialog";

const api = (window as any).harness;

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, AgentMessage[]>>({});
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!api) {
      toast.error("Harness API not available. Run in Electron.");
      return;
    }

    const unsub = api.onEvent((event: MainToRendererEvent) => {
      switch (event.type) {
        case "agent:list":
          setAgents(event.agents);
          break;
        case "agent:created":
          setAgents(prev => [...prev, event.agent]);
          break;
        case "agent:destroyed":
          setAgents(prev => prev.filter(a => a.id !== event.agentId));
          if (activeAgentId === event.agentId) setActiveAgentId(null);
          break;
        case "agent:updated":
          setAgents(prev => prev.map(a => a.id === event.agent.id ? event.agent : a));
          break;
        case "agent:status":
          setAgents(prev => prev.map(a => a.id === event.agentId ? { ...a, status: event.status } : a));
          break;
        case "agent:usage-update":
          setAgents(prev => prev.map(a => a.id === event.agentId ? { ...a, usage: event.usage } : a));
          break;
        case "agent:message":
          setMessages(prev => {
            const msgs = [...(prev[event.message.agentId] ?? [])];
            // If a placeholder already exists (from agent:tool-start), merge into it
            const existingIdx = msgs.findIndex(m => m.id === event.message.id);
            if (existingIdx >= 0) {
              msgs[existingIdx] = { ...msgs[existingIdx], ...event.message, toolCalls: msgs[existingIdx].toolCalls ?? event.message.toolCalls };
            } else {
              msgs.push(event.message);
            }
            return { ...prev, [event.message.agentId]: msgs };
          });
          break;
        case "agent:message-update":
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            let idx = msgs.findIndex(m => m.id === event.messageId);
            if (idx < 0) {
              // Create placeholder if message not yet received (IPC ordering)
              msgs.push({ id: event.messageId, agentId: event.agentId, role: "assistant", content: "", timestamp: Date.now(), isStreaming: true });
              idx = msgs.length - 1;
            }
            if (event.deltaType === "text") msgs[idx] = { ...msgs[idx], content: msgs[idx].content + event.delta };
            else msgs[idx] = { ...msgs[idx], thinking: (msgs[idx].thinking ?? "") + event.delta };
            return { ...prev, [event.agentId]: msgs };
          });
          break;
        case "agent:message-end":
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            const idx = msgs.findIndex(m => m.id === event.messageId);
            if (idx >= 0) msgs[idx] = { ...msgs[idx], content: event.content, thinking: event.thinking, isStreaming: false };
            return { ...prev, [event.agentId]: msgs };
          });
          break;
        case "agent:tool-start":
        case "agent:tool-update":
        case "agent:tool-end": {
          setMessages(prev => {
            const msgs = [...(prev[event.agentId] ?? [])];
            const idx = msgs.findIndex(m => m.id === event.messageId);
            if (idx < 0) return prev;
            if (event.type === "agent:tool-start")
              msgs[idx] = { ...msgs[idx], toolCalls: [...(msgs[idx].toolCalls ?? []), event.toolCall] };
            else if (event.type === "agent:tool-update")
              msgs[idx] = { ...msgs[idx], toolCalls: (msgs[idx].toolCalls ?? []).map(tc => tc.callId === event.callId ? { ...tc, status: "running" as const, result: `${tc.result ?? ""}${event.partial}` } : tc) };
            else
              msgs[idx] = { ...msgs[idx], toolCalls: (msgs[idx].toolCalls ?? []).map(tc => tc.callId === event.callId ? { ...tc, status: event.isError ? "error" as const : "success" as const, result: event.result, isError: event.isError } : tc) };
            return { ...prev, [event.agentId]: msgs };
          });
          break;
        }
        case "error": {
          toast.error(event.agentId ? `[${event.agentId.slice(0, 6)}] ${event.message}` : event.message, { duration: 5000 });
          break;
        }
      }
    });

    return unsub;
  }, [activeAgentId]);

  useEffect(() => {
    if (!activeAgentId && agents.length > 0) {
      const chatAgent = agents.find(a => a.role === "chat");
      setActiveAgentId(chatAgent?.id ?? agents[0].id);
    }
  }, [agents, activeAgentId]);

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
  const handleThinkingChange = useCallback(async (level: string) => {
    if (!activeAgentId || !api) return;
    await api.updateThinking(activeAgentId, level);
    setAgents(prev => prev.map(a => a.id === activeAgentId ? { ...a, thinkingLevel: level as ThinkingLevel } : a));
  }, [activeAgentId]);
  const handleModelChanged = useCallback((newModel: string) => {
    setAgents(prev => prev.map(a => a.id === activeAgentId ? { ...a, model: newModel } : a));
  }, [activeAgentId]);

  const activeAgent = agents.find(a => a.id === activeAgentId);
  const activeMessages = activeAgentId ? messages[activeAgentId] ?? [] : [];

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
    <TooltipProvider>
      <div className="app-shell flex h-screen overflow-hidden bg-background p-2">
        <Sidebar
          agents={agents}
          activeAgentId={activeAgentId}
          onSelect={handleSelectAgent}
          onDestroy={handleDestroyAgent}
          onCreateClick={() => setShowCreateDialog(true)}
          onQuickCreateChat={() => {
            if (!api) return;
            api.createAgent("聊天助手", "chat", undefined, undefined, activeAgentId).then((r: any) => {
              if (r?.success && r.agentId) setActiveAgentId(r.agentId);
            });
          }}
          onSettingsClick={() => setShowSettings(true)}
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
                onSend={handleSendMessage}
                onThinkingChange={handleThinkingChange}
                onModelChange={handleModelChanged}
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

        {showCreateDialog && <AgentCreateDialog onCreate={handleCreateAgent} onClose={() => setShowCreateDialog(false)} />}
        {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      </div>
    </TooltipProvider>
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

