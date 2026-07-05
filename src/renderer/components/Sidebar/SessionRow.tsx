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
import { Bot, ChevronDown, ChevronRight, Copy, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { ChildSessionInfo, SessionRowProps } from "./types";
import { fmtRelativeTime } from "./utils";

function SessionRowImpl({
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
	const hasChildren = childrenList.length > 0;
	const feishuLabel = t("settings.feishu", "Feishu");
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
							<span className="flex min-w-0 items-center gap-1 text-[11px] font-medium">
								{agent.imProvider === "feishu" && <FeishuIcon label={feishuLabel} />}
								<span className="min-w-0 truncate">
									{agent.name}
									{hasChildren && (
										<span className="ml-1 text-[9px] text-sky-500">({childrenList.length})</span>
									)}
								</span>
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
			{/* Sub-sessions — 使用预计算的 phase/running，无需订阅全局 atom */}
			{!collapsedSubSessions.has(agent.id) &&
				childrenList.map((child: ChildSessionInfo) => (
					<div
						key={child.agent.id}
						data-agent-id={child.agent.id}
						data-agent-status={child.childPhase}
						data-running={child.childRunning || undefined}
						className="session-ledger-row subsession-tree-row group/session ml-[18px] flex h-[32px] items-center gap-1.5 rounded-md border border-transparent pl-2 pr-1"
					>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
							onClick={() => selectSession(child.agent)}
						>
							<Bot className="size-3 shrink-0 text-sky-500" />
							{child.agent.imProvider === "feishu" && <FeishuIcon label={feishuLabel} />}
							<span className="min-w-0 flex-1 truncate text-[10px] font-medium">
								{child.agent.name || child.agent.agentConfigName}
							</span>
						</button>
					</div>
				))}
		</div>
	);
}

// memo 包裹: 关闭 SettingsDialog 后 App.tsx 仍会订阅 showSettingsAtom,
// 整树重渲染会让所有 SessionRow 重新执行 render。用 memo 把不变化的行挡掉,
// 是减少 ~13 次无意义 render 及其子树(react-icons、Radix DropdownMenu)的最直接手段。
// 配合 ProjectTree 中稳定的 useCallback(callbacks),命中浅比较。
const SessionRow = memo(SessionRowImpl);
export default SessionRow;

function FeishuIcon({ label }: { label: string }) {
	return (
		<svg viewBox="0 0 16 16" className="size-3 shrink-0" role="img" aria-label={label} focusable="false">
			<path d="M7.1 1.2h1.8a1.8 1.8 0 0 1 1.8 1.8v2.8H8.9A3.6 3.6 0 0 1 5.3 2.2a1 1 0 0 1 1-1h.8Z" fill="#3370FF" />
			<path d="M10.2 5.3h2.6a1.8 1.8 0 0 1 1.8 1.8v1.8a1 1 0 0 1-1 1A3.6 3.6 0 0 1 10 6.3v-1Z" fill="#00B96B" />
			<path d="M5.3 10.2h1.8a3.6 3.6 0 0 1 3.6 3.6 1 1 0 0 1-1 1H7.9a1.8 1.8 0 0 1-1.8-1.8v-2.8Z" fill="#FFB020" />
			<path d="M1.4 7.1a1.8 1.8 0 0 1 1.8-1.8h2.6v1A3.6 3.6 0 0 1 2.2 9.9a1 1 0 0 1-1-1V7.1Z" fill="#F54A45" />
		</svg>
	);
}
