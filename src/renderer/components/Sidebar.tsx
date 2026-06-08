// ============================================================
// Sidebar — Frosted Glass + Line-Drawing (Ink Wash, shadcn/ui)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { cn } from "@shared/lib/utils";
import type { AgentInfo, ProjectInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { MessageSquare, Network, Plus, Settings, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	activeProjectAtom,
	activeProjectIdAtom,
	agentsAtom,
	projectsAtom,
	recentlyCompletedAtom,
	runningAgentsAtom,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import ProjectSelector from "./ProjectSelector";

const api = (window as any).look;

interface SidebarProps {
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	/** Opens the Create dialog. Optional `defaultModel` is the model the
	 *  dialog should pre-select (e.g. the active agent's model). */
	onCreateClick: (defaultModel?: string) => void;
	onQuickCreateChat: () => void;
	onSettingsClick: () => void;
	/** Project callbacks */
	onSelectProject: (projectId: string) => void;
	onCreateProject: () => void;
	onDeleteProject: (project: ProjectInfo) => void;
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
	onSelectProject,
	onCreateProject,
	onDeleteProject,
}: SidebarProps) {
	const { t } = useTranslation();
	const [tab, setTab] = React.useState("chat");
	const agents = useAtomValue(agentsAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const projects = useAtomValue(projectsAtom);
	const activeProjectId = useAtomValue(activeProjectIdAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const recentlyCompleted = useAtomValue(recentlyCompletedAtom);
	const runningAgents = useAtomValue(runningAgentsAtom);
	const activeChatAtBottom = useAtomValue(activeChatAtBottomAtom);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	const filteredAgents = agents.filter(tab === "chat" ? isChatAgent : isOrchAgent);
	const chatCount = agents.filter(isChatAgent).length;
	const orchCount = agents.filter(isOrchAgent).length;
	const activeAgent = agents.find((a) => a.id === activeAgentId);
	const projectValid = !activeProjectId || (activeProject?.valid ?? false);
	const hasActiveProject = activeProjectId !== null;

	// Auto-switch tab + scroll active card into view.
	// Two effects so tab switch happens first, then the re-render exposes the
	// card in the DOM, and the second effect scrolls it into view.
	useEffect(() => {
		const agent = agents.find((a) => a.id === activeAgentId);
		if (agent && !isChatAgent(agent)) setTab("orch");
		else if (agent && isChatAgent(agent)) setTab("chat");
	}, [activeAgentId]);

	useEffect(() => {
		if (!activeAgentId) return;
		const raf = requestAnimationFrame(() => {
			document
				.querySelector(`[data-agent-id="${activeAgentId}"]`)
				?.scrollIntoView({ behavior: "smooth", block: "end" });
		});
		return () => cancelAnimationFrame(raf);
	}, [activeAgentId, tab]);

	// Auto-scroll to the bottom when a new agent is appended (not replaced).
	const listEndRef = useRef<HTMLDivElement>(null);
	const prevIdsRef = useRef<Set<string>>(new Set(filteredAgents.map((a) => a.id)));
	useEffect(() => {
		const prevIds = prevIdsRef.current;
		const newIds = filteredAgents.map((a) => a.id);
		// Only scroll when the list grew and overlaps with the previous set
		// (appending), not when it's a wholesale replacement (tab/project switch).
		if (newIds.length > prevIds.size && newIds.some((id) => prevIds.has(id))) {
			listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
		}
		prevIdsRef.current = new Set(newIds);
	}, [filteredAgents]);

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
			<ProjectSelector
				projects={projects}
				activeProjectId={activeProjectId}
				onSelectProject={onSelectProject}
				onCreateProject={onCreateProject}
				onDeleteProject={onDeleteProject}
			/>
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
					disabled={!hasActiveProject || !projectValid}
				>
					<Plus className="size-4" />
					{t("sidebar.newAgent")}
				</Button>
			</div>

			{!projectValid && activeProjectId && (
				<div className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
					{"⚠ " +
						t("project.pathMissing", "Project path does not exist. The folder may have been moved or deleted.")}
				</div>
			)}
			<ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-scrollbar]]:hidden" type="always">
				<div className="flex flex-col gap-1.5 px-3 pb-3">
					{filteredAgents.map((agent) => {
						const isActive = agent.id === activeAgentId;
						return (
							<div
								key={agent.id}
								data-agent-id={agent.id}
								data-agent-status={agent.status}
								data-running={runningAgents.has(agent.id) || undefined}
								data-completed={
									recentlyCompleted.includes(agent.id) && !(isActive && activeChatAtBottom) ? "" : undefined
								}
								role="button"
								tabIndex={0}
								onClick={() => {
									// Clear the "recently completed" flag on click
									if (recentlyCompleted.includes(agent.id)) {
										appStore.set(
											recentlyCompletedAtom,
											recentlyCompleted.filter((id) => id !== agent.id),
										);
									}
									onSelect(agent.id);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										if (recentlyCompleted.includes(agent.id)) {
											appStore.set(
												recentlyCompletedAtom,
												recentlyCompleted.filter((id) => id !== agent.id),
											);
										}
										onSelect(agent.id);
									}
								}}
								className={cn(
									"group flex w-full items-center gap-2.5 rounded-lg px-0 py-3.5 pl-2 text-left max-w-full",
									"border border-transparent transition-colors duration-150",
									"hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden",
									isActive && !runningAgents.has(agent.id) && "border-border bg-accent/60",
								)}
								style={{ transition: "box-shadow 300ms ease-out" }}
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
							{!hasActiveProject
								? t("sidebar.pleaseOpenProject", "Please open a project first")
								: tab === "chat"
									? t("sidebar.noChatAgents")
									: t("sidebar.noOrchAgents")}
							<br />
							{t("sidebar.clickNewAgent")}
						</div>
					)}
					<div ref={listEndRef} />
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
