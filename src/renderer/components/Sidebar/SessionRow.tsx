// ============================================================
// Sidebar/SessionRow — 会话行（状态标记/编辑/子会话/右键菜单）
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import type { AgentInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { Bot, ChevronDown, ChevronRight, Copy, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { runningAgentsAtom, sessionPhasesAtom } from "../../store/atoms";
import type { SessionRowProps } from "./types";
import { fmtRelativeTime } from "./utils";

export default function SessionRow({
	agent,
	isActive,
	isRunning,
	phase,
	isCompleted,
	editingSessionId,
	editRef,
	editValue,
	setEditValue,
	commitEdit,
	handleEditKeyDown,
	beginEdit,
	selectSession,
	collapsedSubSessions,
	toggleSubSessions,
	childrenList,
	copySessionId,
	exportSession,
	onDestroy,
}: SessionRowProps) {
	const { t } = useTranslation();
	const runningAgents = useAtomValue(runningAgentsAtom);
	const sessionPhases = useAtomValue(sessionPhasesAtom);
	const hasChildren = childrenList.length > 0;
	return (
		<div className="session-tree-group" data-has-children={hasChildren || undefined}>
			<div
				data-agent-id={agent.id}
				data-agent-status={phase}
				data-running={isRunning || undefined}
				data-completed={isCompleted ? "" : undefined}
				data-active={isActive || undefined}
				className="session-ledger-row group/session flex h-[38px] items-center gap-2 rounded-md border border-transparent px-2"
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
					onClick={() => selectSession(agent)}
					onDoubleClick={() => beginEdit("session", agent.id, agent.name)}
				>
					<span className="status-mark" data-status={phase} />
					<span className="min-w-0 flex-1">
						{editingSessionId === agent.id ? (
							<input
								ref={editRef}
								aria-label="编辑会话名称"
								value={editValue}
								onChange={(event) => setEditValue(event.target.value)}
								onBlur={commitEdit}
								onKeyDown={handleEditKeyDown}
								onClick={(event) => event.stopPropagation()}
								className="w-full border-b border-foreground/40 bg-transparent text-[11px] font-medium outline-none"
							/>
						) : (
							<span className="block truncate text-[11px] font-medium">
								{agent.name}
								{hasChildren && <span className="ml-1 text-[9px] text-sky-500">({childrenList.length})</span>}
							</span>
						)}
						<span className="block truncate font-mono text-[8.5px] leading-tight text-muted-foreground/50">
							{isRunning
								? t(`session.status.${phase}`, phase)
								: agent.model ||
									(agent.sessionFilePath
										? t("session.messageCount", {
												count: agent.messageCount,
												defaultValue: "{{count}} messages",
											})
										: t("session.draft", "draft"))}
						</span>
					</span>
					<span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">
						{fmtRelativeTime(agent.createdAt)}
					</span>
				</button>
				{hasChildren && (
					<button
						type="button"
						className="shrink-0 p-0.5 text-muted-foreground/30 hover:text-muted-foreground"
						onClick={(e) => toggleSubSessions(agent.id, e)}
						title={collapsedSubSessions.has(agent.id) ? "展开子会话" : "折叠子会话"}
					>
						{collapsedSubSessions.has(agent.id) ? (
							<ChevronRight className="size-3" />
						) : (
							<ChevronDown className="size-3" />
						)}
					</button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="line-ghost"
							size="icon-xs"
							className="-mr-1 opacity-0 group-hover/session:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
							aria-label={t("session.menu", "Session menu")}
						>
							<MoreHorizontal className="size-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem
							onSelect={() => beginEdit("session", agent.id, agent.name)}
							className="gap-2 text-[12px]"
						>
							<Pencil className="size-3.5" /> {t("sidebar.rename", "Rename")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => copySessionId(agent.id)} className="gap-2 text-[12px]">
							<Copy className="size-3.5" /> {t("sidebar.copyId", "Copy session ID")}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => exportSession(agent.id)} className="gap-2 text-[12px]">
							<Download className="size-3.5" /> {t("sidebar.exportChat", "Export session")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => onDestroy(agent.id)}
							className="gap-2 text-[12px]"
						>
							<Trash2 className="size-3.5" /> {t("sidebar.delete", "Delete")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{/* Sub-sessions */}
			{!collapsedSubSessions.has(agent.id) &&
				childrenList.map((child: AgentInfo) => {
					const childPhase = sessionPhases.get(child.id) ?? "idle";
					const childRunning = runningAgents.has(child.id);
					return (
						<div
							key={child.id}
							data-agent-id={child.id}
							data-agent-status={childPhase}
							data-running={childRunning || undefined}
							className="session-ledger-row subsession-tree-row group/session ml-[18px] flex h-[32px] items-center gap-1.5 rounded-md border border-transparent pl-2 pr-1"
						>
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
								onClick={() => selectSession(child)}
							>
								<Bot className="size-3 shrink-0 text-sky-500" />
								<span className="min-w-0 flex-1 truncate text-[10px] font-medium">
									{child.name || child.agentConfigName}
								</span>
							</button>
						</div>
					);
				})}
		</div>
	);
}
