// ============================================================
// PermissionDialog — Question panel for the permission gate.
//
// Shown when the main process's extension hook wants user input
// for a tool call. Three actions:
//   - Allow:          run with current args
//   - Allow + edit:   run with patched args (path-only editor for v1)
//   - Deny:           block, surface the reason to the agent
//
// If a second `permission:ask` arrives while the user is deciding
// the first, the renderer queues it and shows the next one as soon
// as the current one is decided (or times out, default deny).
// ============================================================

import React, { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@shared/components/ui/dialog";
import { Button } from "@shared/components/ui/button";
import { Badge } from "@shared/components/ui/badge";
import { Input } from "@shared/components/ui/input";
import { ShieldAlert, ShieldCheck, ShieldX, Terminal, FileText, Edit3, ChevronRight, Hash } from "lucide-react";

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

interface PermissionDialogProps {
  request: PermissionRequest | null;
  /** Total queue size, including the one being shown (>1 → "N more"). */
  queueDepth?: number;
  onAllow: () => void;
  onDeny: () => void;
  onEdit: (patchedArgs: Record<string, unknown>) => void;
}

function toolIcon(name: string) {
  if (name === "bash" || name === "Bash") return <Terminal className="size-3.5" />;
  if (name === "read" || name === "Read") return <FileText className="size-3.5" />;
  if (name === "edit" || name === "Edit" || name === "write" || name === "Write") return <Edit3 className="size-3.5" />;
  return <Hash className="size-3.5" />;
}

function toolHasPath(name: string): boolean {
  return name === "read" || name === "write" || name === "edit";
}

function defaultArgSummary(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  return JSON.stringify(args, null, 2);
}

export function PermissionDialog({ request, queueDepth = 1, onAllow, onDeny, onEdit }: PermissionDialogProps) {
  const [editMode, setEditMode] = useState(false);
  const [pathValue, setPathValue] = useState("");

  // Reset edit state when a new request arrives.
  useEffect(() => {
    if (request) {
      setEditMode(false);
      setPathValue(typeof request.args.path === "string" ? request.args.path : "");
    }
  }, [request?.requestId]);

  const open = request !== null;
  const canEdit = request ? toolHasPath(request.toolName) : false;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onDeny(); }}>
      <DialogContent className="max-w-md">
        {request && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md border border-hairline bg-muted/40 text-foreground">
                  {toolIcon(request.toolName)}
                </span>
                <DialogTitle>Permission requested</DialogTitle>
                {queueDepth > 1 && (
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                    +{queueDepth - 1} more
                  </Badge>
                )}
              </div>
              <DialogDescription>
                Agent wants to run a tool that the permission gate flagged.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 -mt-1">
              <div className="flex items-center gap-2 text-[12px]">
                <Badge variant="outline" className="font-mono text-[10px]">{request.toolName}</Badge>
                <span className="text-muted-foreground/60">·</span>
                <span className="text-muted-foreground">agent {request.agentId.slice(0, 6)}</span>
              </div>

              <div className="rounded-md border border-hairline bg-muted/30 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Reason</div>
                <div className="mt-0.5 text-[12px] text-foreground">{request.reason}</div>
              </div>

              {editMode && canEdit ? (
                <div className="rounded-md border border-hairline bg-muted/30 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Edit path</div>
                  <Input
                    value={pathValue}
                    onChange={(e) => setPathValue(e.target.value)}
                    className="mt-1 h-7 text-[12px] font-mono"
                    autoFocus
                  />
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    Other arguments will be preserved.
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-hairline bg-muted/30 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Arguments</div>
                  <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                    {defaultArgSummary(request.toolName, request.args)}
                  </pre>
                </div>
              )}
            </div>

            <DialogFooter className="-mx-4 -mb-4 mt-2">
              <Button variant="outline" size="sm" onClick={onDeny} className="gap-1.5">
                <ShieldX className="size-3.5" /> Deny
              </Button>
              {canEdit && !editMode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditMode(true)}
                  className="gap-1.5"
                >
                  <Edit3 className="size-3.5" /> Allow with edits
                  <ChevronRight className="size-3" />
                </Button>
              )}
              {editMode && canEdit ? (
                <Button
                  variant="line"
                  size="sm"
                  onClick={() => onEdit({ path: pathValue })}
                  className="gap-1.5"
                >
                  <ShieldCheck className="size-3.5" /> Allow edited
                </Button>
              ) : (
                <Button variant="line" size="sm" onClick={onAllow} className="gap-1.5">
                  <ShieldCheck className="size-3.5" /> Allow
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
