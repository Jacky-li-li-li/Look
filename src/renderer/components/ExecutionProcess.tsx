// ============================================================
// ExecutionProcess — Wraps thinking + tools into a collapsible panel
// ============================================================

import React, { useState, useEffect } from "react";
import { cn } from "@shared/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@shared/components/ui/collapsible";
import { ChevronRight, ListTree } from "lucide-react";

interface ExecutionProcessProps {
  thinking?: string;
  toolCalls?: Array<{ callId: string; toolName: string; status: string }>;
  hasOutput: boolean;
  children: React.ReactNode;
}

export default function ExecutionProcess({
  thinking,
  toolCalls,
  hasOutput,
  children,
}: ExecutionProcessProps) {
  const [open, setOpen] = useState(true);
  const autoCollapsed = React.useRef(false);

  // Auto-collapse when output content arrives (streaming starts)
  useEffect(() => {
    if (hasOutput && !autoCollapsed.current) {
      setOpen(false);
      autoCollapsed.current = true;
    }
  }, [hasOutput]);

  const stepCount = (thinking ? 1 : 0) + (toolCalls?.length ?? 0);
  if (stepCount === 0) return null;

  const steps: string[] = [];
  if (thinking) steps.push("💭 Reasoning");
  toolCalls?.forEach(tc => {
    const icon = tc.status === "success" ? "✅" : tc.status === "error" ? "❌" : tc.status === "running" ? "⟳" : "🔧";
    steps.push(`${icon} ${tc.toolName}`);
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="inset-drawer">
        <CollapsibleTrigger asChild>
          <button className="inset-drawer__trigger">
            <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
            <ListTree className="size-3.5 shrink-0 text-amber-400" />
            <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">
              执行过程
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {stepCount} step{stepCount > 1 ? "s" : ""}
              &nbsp;·&nbsp;
              {open ? "展开" : "已折叠"}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="inset-drawer__content" style={{ maxHeight: "none", overflow: "visible" }}>
            <div className="flex flex-col gap-2">
              {children}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
