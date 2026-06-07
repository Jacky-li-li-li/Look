// ============================================================
// Sidebar — Frosted Glass + Line-Drawing (Ink Wash, shadcn/ui)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { cn } from "@shared/lib/utils";
import type { AgentInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { MessageSquare, Network, Plus, Settings, X } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { activeAgentIdAtom, agentsAtom } from "../store/atoms";

const api = (window as any).look;

interface SidebarProps {
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	/** Opens the Create dialog. Optional `defaultModel` is the model the
	 *  dialog should pre-select (e.g. the active agent's model). */
	onCreateClick: (defaultModel?: string) => void;
	onQuickCreateChat: () => void;
	onSettingsClick: () => void;
}

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
function fmtRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}D`;
}

export default function Sidebar({
	onSelect,
	onDestroy,
	onCreateClick,
	onQuickCreateChat,
	onSettingsClick,
}: SidebarProps) {
	const { t } = useTranslation();
	const [tab, setTab] = React.useState("chat");
	const agents = useAtomValue(agentsAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	const filteredAgents = agents.filter(tab === "chat" ? isChatAgent : isOrchAgent);
	const chatCount = agents.filter(isChatAgent).length;
	const orchCount = agents.filter(isOrchAgent).length;
	const activeAgent = agents.find((a) => a.id === activeAgentId);

	const handleDoubleClick = useCallback((agent: AgentInfo) => {
		setEditingId(agent.id);
		setEditValue(agent.name);
		setTimeout(() => editRef.current?.select(), 0);
	}, []);

	const cancelRename = useCallback(() => {
		setEditingId(null);
		setEditValue("");
	}, []);

	const commitRename = useCallback(() => {
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
				e.stopPropagation();
				commitRename();
			}
			if (e.key === "Escape") {
				e.stopPropagation();
				setEditingId(null);
				setEditValue("");
			}
		},
		[commitRename],
	);

	return (
		<aside className="flex h-full w-[260px] min-w-[260px] max-w-[260px] shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar">
			<Tabs value={tab} onValueChange={setTab} className="shrink-0">
				<TabsList className="w-full h-auto rounded-none bg-transparent gap-0 px-3 border-b border-hairline">
					<TabsTrigger
						value="chat"
						className="flex-1 gap-2 py-2.5 text-[13px] font-medium rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground transition-colors"
					>
						<MessageSquare className="size-4" />
						{t("sidebar.chat")}
						{chatCount > 0 && (
							<Badge variant="secondary" className="ml-auto h-5 min-w-5 px-1.5 text-[10px]">
								{chatCount}
							</Badge>
						)}
					</TabsTrigger>
					<TabsTrigger
						value="orch"
						className="flex-1 gap-2 py-2.5 text-[13px] font-medium rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground transition-colors"
					>
						<Network className="size-4" />
						{t("sidebar.orch")}
						{orchCount > 0 && (
							<Badge variant="secondary" className="ml-auto h-5 min-w-5 px-1.5 text-[10px]">
								{orchCount}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>
			</Tabs>

			<div className="flex shrink-0 gap-1.5 px-3 py-3">
				<Button
					variant="line"
					size="sm"
					className="h-10 flex-1 justify-start text-[12px] font-medium"
					onClick={tab === "chat" ? onQuickCreateChat : () => onCreateClick(activeAgent?.model)}
				>
					<Plus className="size-4" />
					{t("sidebar.newAgent")}
				</Button>
			</div>

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
										className="relative transition-opacity duration-150"
										onClick={(event) => {
											event.stopPropagation();
											onDestroy(agent.id);
										}}
										aria-label={`Destroy ${agent.name}`}
									>
										<span className="transition-opacity duration-150 group-hover:opacity-0 text-[10px] font-mono">
											{fmtRelativeTime(agent.createdAt)}
										</span>
										<X className="size-3.5 absolute transition-opacity duration-150 opacity-0 group-hover:opacity-100" />
									</Button>
								</div>
							</div>
						);
					})}

					{filteredAgents.length === 0 && (
						<div className="mx-1 mt-3 rounded-lg border border-dashed border-hairline p-5 text-center text-[11px] text-muted-foreground">
							{tab === "chat" ? t("sidebar.noChatAgents") : t("sidebar.noOrchAgents")}
							<br />
							{t("sidebar.clickNewAgent")}
						</div>
					)}
				</div>
			</ScrollArea>

			<div className="flex shrink-0 items-center border-t border-hairline px-3 py-2.5">
				<Button
					variant="line"
					size="default"
					className="h-10 flex-1 justify-start gap-2 text-[12px] font-medium"
					onClick={onSettingsClick}
				>
					<Settings className="size-4" />
					{t("sidebar.settings")}
				</Button>
			</div>
		</aside>
	);
}
