// ============================================================
// Sidebar — Frosted Glass + Line-Drawing (Ink Wash, shadcn/ui)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Separator } from "@shared/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { cn } from "@shared/lib/utils";
import type { AgentInfo } from "@shared/types";
import { MessageSquare, Network, Plus, Settings, X } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).look;

interface SidebarProps {
	agents: AgentInfo[];
	activeAgentId: string | null;
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	/** Opens the Create dialog. Optional `defaultModel` is the model the
	 *  dialog should pre-select (e.g. the active agent's model). */
	onCreateClick: (defaultModel?: string) => void;
	onQuickCreateChat: () => void;
	onSettingsClick: () => void;
}

// Chat tab = "通用工作台". Only agents that are intentionally
// blank-slate belong here. coder/custom are user-defined roles
// with their own workflow — they go to Orch so the user can manage
// them as separate entities, not mixed in with chat assistants.
// Edit this set when adding a new role that should appear in the
// chat tab; otherwise leave it as `new Set(["chat"])`.
const CHAT_TAB_ROLES: ReadonlySet<AgentInfo["role"]> = new Set(["chat"]);
function isChatAgent(agent: AgentInfo): boolean {
	return CHAT_TAB_ROLES.has(agent.role);
}
function isOrchAgent(agent: AgentInfo): boolean {
	return !CHAT_TAB_ROLES.has(agent.role);
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

export default function Sidebar({
	agents,
	activeAgentId,
	onSelect,
	onDestroy,
	onCreateClick,
	onQuickCreateChat,
	onSettingsClick,
}: SidebarProps) {
	const [tab, setTab] = React.useState("chat");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	const filteredAgents = agents.filter(tab === "chat" ? isChatAgent : isOrchAgent);
	const chatCount = agents.filter(isChatAgent).length;
	const orchCount = agents.filter(isOrchAgent).length;
	// The active agent's model is the most-recently-used "configured" model;
	// surface it as the default for new agents.
	const activeAgent = agents.find((a) => a.id === activeAgentId);

	const handleDoubleClick = useCallback((agent: AgentInfo) => {
		setEditingId(agent.id);
		setEditValue(agent.name);
		setTimeout(() => editRef.current?.select(), 0);
	}, []);

	const cancelRename = useCallback(() => {
		// Discard the in-progress edit. Used by Esc and by blur (clicking
		// elsewhere in the sidebar). Only Enter explicitly commits — this
		// matches Finder's rename UX and prevents the data-loss case
		// where a half-typed buffer gets auto-saved when the user clicks
		// away intending to cancel.
		setEditingId(null);
		setEditValue("");
	}, []);

	const commitRename = useCallback(() => {
		// Read the current edit buffer straight from the agents list so
		// we don't race with a state update that's still pending. Skip
		// the API call when nothing has actually changed (the user
		// pressed Enter without editing, or the trimmed name matches
		// the agent's existing name) — saves a round-trip and avoids
		// re-renders for no-op renames.
		if (!editingId) return;
		const original = agents.find((a) => a.id === editingId)?.name;
		if (original === undefined) return;
		const trimmed = editValue.trim();
		if (trimmed.length > 0 && trimmed !== original) {
			api?.renameAgent(editingId, trimmed);
		}
		cancelRename();
	}, [editingId, editValue, agents, cancelRename]);

	const handleEditKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				commitRename();
			}
			if (e.key === "Escape") {
				setEditingId(null);
				setEditValue("");
			}
		},
		[commitRename],
	);

	return (
		<aside className="flex h-full w-[260px] min-w-[260px] max-w-[260px] shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar">
			{/* Header */}
			<div className="flex h-14 shrink-0 items-center justify-between border-b border-hairline px-4">
				<div className="flex items-center gap-3">
					<PixelAgentAvatar size="sm" active />
					<span className="text-[14px] font-semibold">Agents</span>
				</div>
				<div className="flex items-center gap-1">
					<Button size="icon" variant="ghost" className="size-7" onClick={onSettingsClick} aria-label="Settings">
						<Settings className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* Tabs */}
			<Tabs value={tab} onValueChange={setTab} className="shrink-0">
				<TabsList className="w-full rounded-none border-b border-hairline bg-transparent px-3">
					<TabsTrigger
						value="chat"
						className="relative flex-1 gap-1.5 py-3 text-[11px] font-medium text-muted-foreground transition-colors data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-foreground"
					>
						<MessageSquare className="size-3.5" />
						Chat
						{chatCount > 0 && (
							<Badge variant="secondary" className="ml-auto h-4 rounded-sm px-1.5 text-[9px]">
								{chatCount}
							</Badge>
						)}
					</TabsTrigger>
					<TabsTrigger
						value="orch"
						className="relative flex-1 gap-1.5 py-3 text-[11px] font-medium text-muted-foreground transition-colors data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-foreground"
					>
						<Network className="size-3.5" />
						Orch
						{orchCount > 0 && (
							<Badge variant="secondary" className="ml-auto h-4 rounded-sm px-1.5 text-[9px]">
								{orchCount}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>
			</Tabs>

			<Separator />

			{/* Actions */}
			<div className="flex shrink-0 gap-1.5 px-3 py-3">
				<Button
					variant="line"
					size="sm"
					className="h-10 flex-1 justify-start text-[12px] font-medium"
					onClick={tab === "chat" ? onQuickCreateChat : () => onCreateClick(activeAgent?.model)}
				>
					<Plus data-icon="inline-start" className="size-4" />
					New Agent
				</Button>
			</div>

			{/* Agent list */}
			<ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-scrollbar]]:hidden" type="always">
				<div className="flex flex-col gap-1.5 px-3 pb-3">
					{filteredAgents.map((agent) => {
						const isActive = agent.id === activeAgentId;
						return (
							<div
								key={agent.id}
								role="button"
								tabIndex={0}
								onClick={() => onSelect(agent.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onSelect(agent.id);
									}
								}}
								className={cn(
									"group flex w-full items-center gap-2.5 rounded-lg px-0 py-3.5 pl-2 text-left max-w-full",
									"border border-transparent transition-colors duration-150",
									"hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden",
									isActive && "border-border bg-accent/60",
								)}
							>
								<PixelAgentAvatar role={agent.role} status={agent.status} size="sm" active={isActive} />

								<div className="min-w-0 flex-1">
									{editingId === agent.id ? (
										<input
											ref={editRef}
											value={editValue}
											onChange={(e) => setEditValue(e.target.value)}
											onBlur={cancelRename}
											onKeyDown={handleEditKeyDown}
											className="w-full bg-transparent text-[12px] font-semibold outline-none border-b border-border"
											maxLength={64}
										/>
									) : (
										<div
											className="truncate text-[13px] font-semibold"
											onDoubleClick={(e) => {
												e.stopPropagation();
												handleDoubleClick(agent);
											}}
											title={agent.name}
										>
											{agent.name}
										</div>
									)}
									{agent.usage.totalTokens > 0 && (
										<div className="mt-1 font-mono text-[10px] text-muted-foreground/60">
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
										className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
										onClick={(event) => {
											event.stopPropagation();
											onDestroy(agent.id);
										}}
										aria-label={`Destroy ${agent.name}`}
									>
										<X className="size-3.5" />
									</Button>
								</div>
							</div>
						);
					})}

					{filteredAgents.length === 0 && (
						<div className="mx-1 mt-3 rounded-lg border border-dashed border-hairline p-5 text-center text-[11px] text-muted-foreground">
							<div className="mx-auto mb-2 flex justify-center">
								<PixelAgentAvatar size="md" />
							</div>
							{tab === "chat" ? "No chat agents yet." : "No orchestration agents yet."}
							<br />
							Click + New Agent.
						</div>
					)}
				</div>
			</ScrollArea>
		</aside>
	);
}
