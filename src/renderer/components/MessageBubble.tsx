// ============================================================
// MessageBubble — Whisper Bubbles + Inset Drawers (Ink Wash)
// ============================================================

import React from "react";
import { cn } from "@shared/lib/utils";
import { UserRound, Settings2 } from "lucide-react";
import type { AgentMessage, AgentRole } from "@shared/types";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";
import StreamingMarkdown from "./StreamingMarkdown";
import ExecutionProcess from "./ExecutionProcess";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

interface MessageBubbleProps {
  message: AgentMessage;
  agentRole?: AgentRole;
  agentName?: string;
}

export default function MessageBubble({ message, agentRole, agentName }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center py-1">
        <span className="inline-flex max-w-[78%] items-center gap-1.5 rounded-md border border-dashed border-hairline bg-background/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          <Settings2 className="size-3" />
          <span className="truncate">{message.content}</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse self-end")}
         style={{ maxWidth: isUser ? "80%" : "92%" }}>
      {/* Avatar */}
      {!isUser ? (
        <PixelAgentAvatar role={agentRole} size="sm" className="mt-0.5 shrink-0" />
      ) : (
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-hairline bg-background text-foreground">
          <UserRound className="size-3.5" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Sender label */}
        <div className={cn("mb-1 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}>
          <span className="font-medium uppercase tracking-wider">{isUser ? "You" : agentName ?? "Agent"}</span>
          {message.isStreaming && <span className="status-mark" data-status="thinking" />}
        </div>

        {/* Whisper bubble — complete message: thinking → tools → output */}
        <div className={cn(
          "whisper-bubble flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed",
          isUser && "whisper-bubble--user",
          !isUser && "whisper-bubble--assistant w-full",
        )}>
          {/* 执行过程 — wraps thinking + tools, auto-collapses when output arrives */}
          <ExecutionProcess
            thinking={message.thinking}
            toolCalls={message.toolCalls?.map(tc => ({ callId: tc.callId, toolName: tc.toolName, status: tc.status }))}
            hasOutput={!!message.content}
          >
            {message.thinking && <ThinkingPanel thinking={message.thinking} />}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <>
                {message.toolCalls.map((tc) => (
                  <ToolCallCard key={tc.callId} toolCall={tc} />
                ))}
              </>
            )}
          </ExecutionProcess>

          {/* Output */}
          <div className={cn("message-prose", message.isStreaming && "after:ml-0.5 after:animate-pulse after:content-['▊']")}>
            <StreamingMarkdown content={message.content} isStreaming={message.isStreaming ?? false} />
          </div>
        </div>
      </div>
    </div>
  );
}
