// ============================================================
// ModelSelector — Simple Popover (Ink Wash, no Radix DropdownMenu)
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import SimplePopover from "@shared/components/ui/simple-popover";
import { Button } from "@shared/components/ui/button";
import { ChevronDown, Cpu, Check } from "lucide-react";
import type { AvailableModel } from "@shared/types";

const api = (window as any).harness;

interface ModelSelectorProps {
  agentId: string;
  currentModel: string;
  onModelChanged?: (newModel: string) => void;
}

export default function ModelSelector({ agentId, currentModel, onModelChanged }: ModelSelectorProps) {
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [switching, setSwitching] = useState(false);
  const latestPropsRef = useRef({ currentModel, onModelChanged });
  latestPropsRef.current = { currentModel, onModelChanged };

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.getModels().then((r: any) => { if (!cancelled && r?.success) setModels(r.models); });
    return () => { cancelled = true; };
  }, []);

  const handleSwitch = useCallback(async (modelKey: string) => {
    const { currentModel: cur, onModelChanged: onChange } = latestPropsRef.current;
    if (modelKey === cur) return;
    setSwitching(true);
    try {
      const result = await api.switchModel(agentId, modelKey);
      if (result?.success) onChange?.(modelKey);
    } catch { /* ignore */ }
    setSwitching(false);
  }, [agentId]);

  const grouped: Record<string, AvailableModel[]> = {};
  for (const m of models) {
    if (!grouped[m.provider]) grouped[m.provider] = [];
    grouped[m.provider].push(m);
  }

  const label = switching ? "…" : currentModel?.split("/").pop() ?? "Model";

  const trigger = (
    <Button variant="line" size="sm" className="group/selector h-7 max-w-40 font-mono text-[11px]">
      <Cpu data-icon="inline-start" className="size-3" />
      <span className="truncate">{label}</span>
      <ChevronDown data-icon="inline-end" className="size-3 transition-transform duration-150 group-data-[state=open]/selector:rotate-180" />
    </Button>
  );

  return (
    <SimplePopover
      trigger={trigger}
      align="end"
      className="glass-panel-strong w-72 overflow-y-auto rounded-xl border p-1 shadow-xl ring-1 ring-foreground/10"
    >
      {Object.entries(grouped).map(([provider, pModels], index, entries) => (
        <React.Fragment key={provider}>
          <div className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            {provider}
          </div>
          <div>
            {pModels.map((m) => {
              const mk = `${m.provider}/${m.id}`;
              const isActive = mk === currentModel;
              return (
                <button
                  key={mk}
                  type="button"
                  disabled={isActive}
                  onClick={() => handleSwitch(mk)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default disabled:opacity-50"
                >
                  <span className={isActive ? "font-semibold" : ""}>
                    {m.name}
                    {isActive && <Check className="ml-1 inline size-3" />}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {m.reasoning ? "think" : "base"} / {(m.contextWindow / 1000).toFixed(0)}K
                  </span>
                </button>
              );
            })}
          </div>
          {index < entries.length - 1 && (
            <div className="-mx-1 my-1 h-px bg-border" />
          )}
        </React.Fragment>
      ))}
    </SimplePopover>
  );
}
