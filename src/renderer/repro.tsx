import React from "react";
import { createRoot } from "react-dom/client";
import "./App.css";

import { Button } from "@shared/components/ui/button";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Badge } from "@shared/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { Separator } from "@shared/components/ui/separator";
import { Plus, X, MessageSquare, Network, Settings } from "lucide-react";
import { PixelAgentAvatar } from "./components/PixelAgentAvatar";

type AgentInfo = {
  id: string;
  name: string;
  role: string;
  status: string;
  model?: string;
  usage: { totalTokens: number; cost: { total: number } };
};

const ROLE_LABEL: Record<string, string> = {
  chat: "助手",
  orchestrator: "编排器",
  crawler: "爬取器",
  cleaner: "清洗器",
  analyst: "分析师",
  reporter: "报告器",
  coder: "编码器",
  reviewer: "审查器",
  custom: "自定义",
};

function isChatAgent(agent: AgentInfo) {
  return agent.role === "chat" || agent.role === "coder" || agent.role === "custom";
}
function isOrchAgent(agent: AgentInfo) {
  return !isChatAgent(agent);
}
function fmtCost(total: number): string {
  if (total === 0) return "";
  return total < 0.01 ? `$${total.toFixed(4)}` : `$${total.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  if (n === 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

const FAKE_AGENTS: AgentInfo[] = [
  { id: "1", name: "claude-sonnet-4-20250514", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "2", name: "Debug 长名字测试", role: "chat", status: "thinking", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 12453, cost: { total: 0.0432 } } },
  { id: "3", name: "Another one", role: "chat", status: "working", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 88432, cost: { total: 0.21 } } },
  { id: "4", name: "编码器", role: "coder", status: "error", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "5", name: "MiniMax聊天测试", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "6", name: "Another really really long agent name that should truncate nicely", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "7", name: "Seventh", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "8", name: "Eighth", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "9", name: "Ninth", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "10", name: "Tenth", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "11", name: "Eleventh", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
  { id: "12", name: "Twelfth", role: "chat", status: "idle", model: "anthropic/claude-sonnet-4-20250514", usage: { totalTokens: 0, cost: { total: 0 } } },
];

function Sidebar() {
  const [tab, setTab] = React.useState("chat");
  const filtered = FAKE_AGENTS.filter(tab === "chat" ? isChatAgent : isOrchAgent);
  return (
    <aside className="flex h-full w-[260px] min-w-[260px] max-w-[260px] shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-3">
        <div className="flex items-center gap-2.5">
          <PixelAgentAvatar size="sm" active />
          <span className="text-[13px] font-semibold">Agents</span>
        </div>
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="h-5 rounded-md px-1.5 font-mono text-[10px]">{FAKE_AGENTS.length}</Badge>
          <Button size="icon" variant="ghost" className="size-7">
            <Settings className="size-3.5" />
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="shrink-0">
        <TabsList className="h-9 w-full rounded-none border-b border-hairline bg-transparent px-2">
          <TabsTrigger value="chat" className="flex-1 gap-1.5 text-[11px] data-[state=active]:bg-accent">
            <MessageSquare className="size-3" />
            Chat
            <Badge variant="secondary" className="ml-0.5 h-3.5 px-1 py-0 text-[9px]">{FAKE_AGENTS.filter(isChatAgent).length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="orch" className="flex-1 gap-1.5 text-[11px] data-[state=active]:bg-accent">
            <Network className="size-3" />
            Orch
            <Badge variant="secondary" className="ml-0.5 h-3.5 px-1 py-0 text-[9px]">{FAKE_AGENTS.filter(isOrchAgent).length}</Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Separator />

      <div className="flex shrink-0 gap-1.5 px-2.5 py-2.5">
        <Button variant="line" size="sm" className="h-8 flex-1 justify-start text-xs font-medium">
          <Plus data-icon="inline-start" className="size-3.5" />
          New Agent
        </Button>
      </div>

      <ScrollArea className="flex-1 ps-2.5 pe-2.5" type="always">
        <div className="flex flex-col gap-1 scroll-area-content">
          {filtered.map((agent, idx) => {
            const isActive = idx === 1;
            return (
              <div
                key={agent.id}
                data-active={isActive}
                className="liquid-row group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-hidden"
              >
                <PixelAgentAvatar role={agent.role} status={agent.status} size="sm" active={isActive} />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold">{agent.name}</div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="shrink-0">{ROLE_LABEL[agent.role] ?? agent.role}</span>
                    <span className="opacity-30">/</span>
                    <span className="truncate font-mono text-[10px]">{agent.model?.split("/").pop()}</span>
                  </div>
                  {agent.usage.totalTokens > 0 && (
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/60">
                      {fmtTokens(agent.usage.totalTokens)}
                      {agent.usage.cost.total > 0 && ` · ${fmtCost(agent.usage.cost.total)}`}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="status-mark" data-status={agent.status} />
                  <Button
                    variant="line-ghost"
                    size="icon-xs"
                    className="opacity-100"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}

const root = createRoot(document.getElementById("mount")!);
root.render(<Sidebar />);
