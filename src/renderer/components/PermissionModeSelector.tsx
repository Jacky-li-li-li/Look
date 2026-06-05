// ============================================================
// PermissionModeSelector — single-button cycle.
//
// Three modes arranged in a cycle: ask → plan → allow → ask ...
// One click advances to the next mode. The icon and label
// reflect the *current* mode; the tooltip explains what clicking
// will switch to.
// ============================================================

import React from "react";
import { cn } from "@shared/lib/utils";
import { ShieldAlert, BookOpen, ShieldCheck } from "lucide-react";

export type PermissionMode = "ask" | "plan" | "allow";

interface PermissionModeSelectorProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

const CYCLE: PermissionMode[] = ["ask", "plan", "allow"];

const META: Record<PermissionMode, {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = {
  ask: {
    label: "Ask",
    Icon: ShieldAlert,
    description: "Ask before each gated tool",
  },
  plan: {
    label: "Plan",
    Icon: BookOpen,
    description: "Read-only; blocks edits without asking",
  },
  allow: {
    label: "Allow",
    Icon: ShieldCheck,
    description: "Auto-allow every tool (trust this agent)",
  },
};

function nextMode(m: PermissionMode): PermissionMode {
  return CYCLE[(CYCLE.indexOf(m) + 1) % CYCLE.length];
}

export function PermissionModeSelector({ mode, onChange, disabled }: PermissionModeSelectorProps) {
  const { label, Icon, description } = META[mode];
  const next = nextMode(mode);
  const nextLabel = META[next].label;

  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      disabled={disabled}
      title={`${description} · click to switch to ${nextLabel}`}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-muted/30 px-2 text-[10px] font-medium uppercase tracking-wider transition-colors",
        "hover:bg-foreground/5 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-60",
        "text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      <span>{label}</span>
    </button>
  );
}
