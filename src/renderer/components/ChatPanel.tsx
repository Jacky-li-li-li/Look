// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
// ============================================================

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@shared/components/ui/button";
import { Textarea } from "@shared/components/ui/textarea";
import { Send, MessageSquare } from "lucide-react";
import type { AgentMessage, AgentRole, AgentStatus } from "@shared/types";
import MessageBubble from "./MessageBubble";
import ThinkingSelector from "./ThinkingSelector";
import ModelSelector from "./ModelSelector";
import ContextRing from "./ContextRing";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

interface ChatPanelProps {
  agentId: string;
  agentRole?: AgentRole;
  agentName?: string;
  messages: AgentMessage[];
  agentStatus: AgentStatus;
  currentModel: string;
  currentThinking: string;
  onSend: (text: string) => void;
  onThinkingChange: (level: string) => void;
  onModelChange: (model: string) => void;
}

export default function ChatPanel({
  agentId, agentRole, agentName, messages, agentStatus,
  currentModel, currentThinking,
  onSend, onThinkingChange, onModelChange,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rafRef = useRef<number>();

  // Batch scroll to bottom via rAF — avoids forced layout on every streaming delta
  useEffect(() => {
    cancelAnimationFrame(rafRef.current!);
    rafRef.current = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(rafRef.current!);
  }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, [agentId]);

  // Merge consecutive assistant messages (pi may split thinking/tools/output across turns)
  const displayMessages = useMemo(() => {
    const merged: AgentMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === "assistant" && msg.role === "assistant") {
        merged[merged.length - 1] = {
          ...last,
          content: last.content + (last.content && msg.content ? "\n\n" : "") + (msg.content || ""),
          thinking: (last.thinking || "") + (msg.thinking || ""),
          toolCalls: [...(last.toolCalls ?? []), ...(msg.toolCalls ?? [])],
          isStreaming: msg.isStreaming ?? last.isStreaming,
        };
      } else {
        merged.push(msg);
      }
    }
    return merged;
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isBusy = agentStatus === "thinking" || agentStatus === "working";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-5 py-5">
          {displayMessages.length === 0 ? (
            <div className="flex min-h-[52vh] flex-col items-center justify-center gap-4 text-center">
              <div className="relative">
                <PixelAgentAvatar role={agentRole} status={agentStatus} size="lg" />
                <MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-[13px] font-semibold text-foreground">No messages yet</h3>
                <p className="text-[11px] text-muted-foreground">Start with a direct task for this agent.</p>
              </div>
            </div>
          ) : (
            displayMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} agentRole={agentRole} agentName={agentName} />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-hairline bg-background/70 px-4 py-2.5 backdrop-blur-md">
        <div className="mx-auto max-w-[52rem] rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isBusy ? "Agent is working..." : `Message ${agentName ?? "agent"}…`}
            rows={2}
            disabled={isBusy}
            className="min-h-16 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 text-[13px] shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 focus-visible:outline-0"
          />
          <div className="flex items-center gap-1.5 border-t border-hairline px-2 py-2">
            <ModelSelector agentId={agentId} currentModel={currentModel} onModelChanged={onModelChange} />
            <ThinkingSelector agentId={agentId} currentLevel={currentThinking} onChanged={onThinkingChange} />
            <div className="flex-1" />
            <ContextRing agentId={agentId} />
            <Button
              variant={input.trim() && !isBusy ? "line-filled" : "line"}
              size="icon-sm"
              onClick={handleSend}
              disabled={!input.trim() || isBusy}
              aria-label="Send message"
            >
              <Send data-icon="inline-start" className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
