// ============================================================
// AgentCreateDialog — Frosted Glass + Line-Drawing (Ink Wash, shadcn)
// ============================================================

import React, { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@shared/components/ui/dialog";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@shared/components/ui/select";
import { Badge } from "@shared/components/ui/badge";
import { AlertCircle, Plus } from "lucide-react";
import type { AvailableModel, ThinkingLevel } from "@shared/types";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const ROLE_OPTIONS = [
  { value: "orchestrator", label: "Orchestrator", desc: "任务编排" },
  { value: "crawler", label: "Crawler", desc: "数据爬取" },
  { value: "cleaner", label: "Cleaner", desc: "数据清洗" },
  { value: "analyst", label: "Analyst", desc: "数据分析" },
  { value: "reporter", label: "Reporter", desc: "报告生成" },
  { value: "coder", label: "Coder", desc: "代码编写" },
  { value: "reviewer", label: "Reviewer", desc: "代码审查" },
  { value: "custom", label: "Custom", desc: "自定义 Agent" },
];

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Off — 标准模式" },
  { value: "minimal", label: "Minimal — 最少思考" },
  { value: "low", label: "Low — 少量思考" },
  { value: "medium", label: "Medium — 平衡思考" },
  { value: "high", label: "High — 深度思考" },
  { value: "xhigh", label: "X-High — 极限思考" },
];

const ROLE_THINKING_DEFAULTS: Record<string, ThinkingLevel> = {
  orchestrator: "medium", crawler: "low", cleaner: "off",
  analyst: "high", reporter: "medium", coder: "medium",
  reviewer: "off", custom: "medium",
};

const api = (window as any).harness;

interface AgentCreateDialogProps {
  /** Pre-fill the model field (e.g. from the currently active agent). */
  defaultModel?: string;
  onCreate: (name: string, role: string, model?: string, thinkingLevel?: string) => void;
  onClose: () => void;
}

export default function AgentCreateDialog({ defaultModel, onCreate, onClose }: AgentCreateDialogProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("custom");
  const [model, setModel] = useState(defaultModel ?? "");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.getModels().then((r: any) => {
      if (!cancelled && r?.success) setModels(r.models);
      if (!cancelled) setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setThinkingLevel(ROLE_THINKING_DEFAULTS[role] ?? "medium");
  }, [role]);

  const grouped: Record<string, AvailableModel[]> = {};
  for (const m of models) {
    if (!grouped[m.provider]) grouped[m.provider] = [];
    grouped[m.provider].push(m);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-dialog sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <PixelAgentAvatar role={role} size="md" active />
            <div>
              <DialogTitle>Create Agent</DialogTitle>
              <DialogDescription>
                Configure role, thinking depth, and model.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Market Analyst" autoFocus className="bg-background/50" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-full bg-background/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value}>
                      <span className="flex items-center gap-2">
                        <span>{o.label}</span>
                        <span className="text-[11px] text-muted-foreground">{o.desc}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Thinking</Label>
            <Select value={thinkingLevel} onValueChange={(v) => setThinkingLevel(v as ThinkingLevel)}>
              <SelectTrigger className="w-full bg-background/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {THINKING_LEVELS.map(l => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Model</Label>
              {loading && <Badge variant="outline" className="h-5 rounded font-mono text-[10px]">Loading</Badge>}
            </div>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-full bg-background/50">
                <SelectValue placeholder="(inherit from parent)" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(grouped).map(([provider, pModels]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel className="font-mono text-[10px] uppercase tracking-wider">{provider}</SelectLabel>
                    {pModels.map(m => {
                      const mk = `${m.provider}/${m.id}`;
                      return (
                        <SelectItem key={mk} value={mk}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{m.name}</span>
                            {m.reasoning && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">think</span>}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          {models.length === 0 && !loading && (
            <p className="flex items-start gap-2 rounded-md border border-dashed border-hairline bg-background/40 p-3 text-[11px] text-muted-foreground">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              No API keys configured. Set one in Settings or use <code className="rounded bg-muted px-1 font-mono text-[10px]">export ANTHROPIC_API_KEY=...</code>
            </p>
          )}
        </div>

        <DialogFooter className="glass-panel -mx-4 -mb-4 border-t border-hairline">
          <Button variant="line" onClick={onClose}>Cancel</Button>
          <Button variant="line-filled" onClick={() => onCreate(name.trim(), role, model || undefined, thinkingLevel)} disabled={!name.trim()}>
            <Plus data-icon="inline-start" />
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
