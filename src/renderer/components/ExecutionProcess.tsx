// ============================================================
// ExecutionProcess — Inline collapsible group for thinking +
// toolCall blocks within an assistant message. No card chrome:
// just a text trigger row and a left-ruled body that expands
// with CSS grid animation.
// ============================================================

import { cn } from "@shared/lib/utils";
import type { PiContentBlock, PiThinkingBlock, PiToolCallBlock } from "@shared/types";
import { ChevronRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";

interface ExecutionProcessProps {
  blocks: PiContentBlock[];
  isStreaming: boolean;
  autoCollapse: boolean;
}

function buildSummary(
  thinkingCount: number,
  toolCount: number,
  t: (key: string, vars?: Record<string, number>) => string,
): string {
  if (thinkingCount > 0 && toolCount > 0) {
    return t("executionProcess.summary", { thinking: thinkingCount, tools: toolCount });
  }
  if (thinkingCount > 0) {
    return t("executionProcess.summaryThinkingOnly", { thinking: thinkingCount });
  }
  return t("executionProcess.summaryToolsOnly", { tools: toolCount });
}

export default function ExecutionProcess({ blocks, isStreaming, autoCollapse }: ExecutionProcessProps) {
  const { t } = useTranslation();

  const [open, setOpen] = React.useState(isStreaming);
  const userManuallyToggled = React.useRef(false);
  const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const prevStreaming = React.useRef(isStreaming);

  React.useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      if (autoCollapse && !userManuallyToggled.current) {
        collapseTimerRef.current = setTimeout(() => setOpen(false), 300);
      }
    } else if (isStreaming && !userManuallyToggled.current) {
      setOpen(true);
    }
    prevStreaming.current = isStreaming;
    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, [isStreaming, autoCollapse]);

  const { thinkingCount, toolCount } = React.useMemo(() => {
    let tc = 0;
    let toc = 0;
    for (const b of blocks) {
      if (b.type === "thinking") tc++;
      else if (b.type === "toolCall") toc++;
    }
    return { thinkingCount: tc, toolCount: toc };
  }, [blocks]);
  const summary = buildSummary(thinkingCount, toolCount, t);

  return (
    <div className="execution-process">
      <button
        className="execution-process__trigger"
        onClick={() => {
          userManuallyToggled.current = true;
          if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
          setOpen((v) => !v);
        }}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <span>
          {t("executionProcess.title")} · {summary}
        </span>
      </button>

      <div
        className={cn(
          "execution-process__body grid transition-all duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-1.5 pt-1">
            {blocks.map((block, i) => {
              if (block.type === "thinking") {
                const tb = block as PiThinkingBlock;
                if (!tb.thinking) return null;
                return (
                  <ThinkingPanel
                    key={`ep-t-${i}`}
                    thinking={tb.thinking}
                    isStreaming={isStreaming}
                    autoCollapse={false}
                  />
                );
              }
              if (block.type === "toolCall") {
                const tc = block as PiToolCallBlock;
                return (
                  <ToolCallCard
                    key={tc.id || `ep-tc-${i}`}
                    toolCall={{
                      callId: tc.id,
                      toolName: tc.name,
                      args: tc.arguments,
                      status: tc.status,
                      result: tc.result,
                      isError: tc.isError,
                    }}
                  />
                );
              }
              return null;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
