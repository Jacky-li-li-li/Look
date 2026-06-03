// ============================================================
// ToolCallCard — Inset Drawer (Ink Wash, shadcn/ui)
// ============================================================

import React from "react";
import { cn } from "@shared/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@shared/components/ui/collapsible";
import { Badge } from "@shared/components/ui/badge";
import { Wrench, ChevronRight, Check, X, Loader2 } from "lucide-react";
import type { ToolCallRecord } from "@shared/types";

interface ToolCallCardProps {
  toolCall: ToolCallRecord;
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [open, setOpen] = React.useState(false);

  const argsJson = safeJson(toolCall.args);
  const argsPreview = argsJson.slice(0, 80);
  const hasBody = (toolCall.result && toolCall.result.length > 0) || argsPreview.length > 0;

  const statusVariant =
    toolCall.status === "success" ? "outline"
    : toolCall.status === "error" ? "destructive"
    : "secondary";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="inset-drawer">
        <CollapsibleTrigger asChild>
          <button
            className={cn("inset-drawer__trigger", !hasBody && "cursor-default")}
            disabled={!hasBody}
          >
            <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
            <StatusIcon status={toolCall.status} />
            <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] font-medium text-foreground">
              {toolCall.toolName}
            </span>
            <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground max-w-32">
              {argsPreview || "no args"}
            </span>
            <Badge variant={statusVariant as any} className="h-5 shrink-0 rounded px-1.5 font-mono text-[9px]">
              {toolCall.status}
            </Badge>
          </button>
        </CollapsibleTrigger>

        {hasBody && (
          <CollapsibleContent>
            <div className="inset-drawer__content">
              <div className="flex flex-col gap-3 text-[10px] leading-relaxed">
                <section className="flex flex-col gap-1">
                  <span className="inset-drawer__label text-foreground">Arguments</span>
                  <pre className="whitespace-pre-wrap break-all text-muted-foreground">{argsJson || "{}"}</pre>
                </section>
                {toolCall.result && (
                  <section className="flex flex-col gap-1">
                    <span className="inset-drawer__label text-foreground">{toolCall.isError ? "Error" : "Result"}</span>
                    <pre className={cn("whitespace-pre-wrap break-words", toolCall.isError ? "text-destructive" : "text-muted-foreground")}>
                      {toolCall.result}
                    </pre>
                  </section>
                )}
              </div>
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

function StatusIcon({ status }: { status: ToolCallRecord["status"] }) {
  const cls = "size-3.5 shrink-0";
  if (status === "success") return <Check className={cn(cls, "text-emerald-400")} />;
  if (status === "error") return <X className={cn(cls, "text-red-400")} />;
  if (status === "running") return <Loader2 className={cn(cls, "animate-spin text-amber-400")} />;
  return <Wrench className={cn(cls, "text-muted-foreground")} />;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); }
}
