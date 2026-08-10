// ============================================================
// TopSessionBar — 顶部栏：始终显示当前会话标题，双击可重命名
//
// 已取消原「多会话页签条」（SessionSheetBar）功能：顶部不再渲染
// 水平页签列表（拖拽排序 / 点击切换 / 关闭）。此处始终显示当前会话
// 标题（单行省略），双击标题进入重命名编辑态（Enter / 失焦提交，
// Escape 取消），复用 pi 的 renameAgent 能力。窗口拖拽区、macOS
// 红绿灯留白与右侧面板展开按钮保留。
//
// 类名沿用 session-sheet-bar：App.css 中针对该顶栏的 padding 过渡
// 与侧栏折叠让位样式继续生效。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { AgentInfo } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { PanelLeftOpen, StickyNote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { appStore } from "../store/appStore";
import { rightPanelCollapsedAtom, sidebarEffectiveCollapsedAtom, stickyNoteExpandRequestAtom } from "../store/atoms";

interface TopSessionBarProps {
	activeAgent: AgentInfo | null;
}

export default function TopSessionBar({ activeAgent }: TopSessionBarProps) {
	const { t } = useTranslation();
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom);
	const setRightPanelCollapsed = useSetAtom(rightPanelCollapsedAtom);

	// 双击重命名编辑态（与 Sidebar 的编辑互不影响，独立管理）
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const editRef = useRef<HTMLInputElement>(null);

	// 切换会话（activeSessionId 变化）时重置编辑态
	const activeSessionId = activeAgent?.id ?? null;
	useEffect(() => {
		if (activeSessionId === null) return;
		setEditing(false);
		setEditValue("");
	}, [activeSessionId]);

	const beginEdit = useCallback(() => {
		if (!activeAgent) return;
		setEditValue(activeAgent.name);
		setEditing(true);
		requestAnimationFrame(() => {
			editRef.current?.focus();
			editRef.current?.select();
		});
	}, [activeAgent]);

	const cancelEdit = useCallback(() => {
		setEditing(false);
		setEditValue("");
	}, []);

	const commitEdit = useCallback(() => {
		const value = editValue.trim();
		if (value && activeAgent) window.look?.renameAgent(activeAgent.id, value);
		cancelEdit();
	}, [activeAgent, cancelEdit, editValue]);

	const handleEditKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				commitEdit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				cancelEdit();
			}
		},
		[cancelEdit, commitEdit],
	);

	return (
		<header
			className={cn(
				"session-sheet-bar app-drag relative flex h-12 shrink-0 items-center gap-2 border-b border-hairline",
				rightPanelCollapsed ? "px-2" : "pl-2",
				// 侧栏折叠时红绿灯会压到左侧，macOS 非全屏时让出左侧位置；
				// 展开入口由侧边栏按钮组（fixed 左上角）提供，此处不再渲染展开按钮。
				sidebarCollapsed && "mac-titlebar-pad",
			)}
		>
			{activeAgent ? (
				<div
					className={cn(
						"app-no-drag flex h-full min-w-0 flex-1 items-center px-2",
						rightPanelCollapsed ? "pr-20" : "pr-12",
					)}
				>
					{editing ? (
						<input
							ref={editRef}
							aria-label={t("sidebar.editSessionName", "编辑会话名称")}
							value={editValue}
							onChange={(event) => setEditValue(event.target.value)}
							onBlur={commitEdit}
							onKeyDown={handleEditKeyDown}
							onClick={(event) => event.stopPropagation()}
							className="field-sizing-content max-w-full min-w-16 border-b border-foreground/40 bg-transparent text-sm font-medium outline-none"
						/>
					) : (
						<span
							className="min-w-0 cursor-text truncate text-sm font-medium text-foreground"
							onDoubleClick={beginEdit}
						>
							{activeAgent.name}
						</span>
					)}
				</div>
			) : (
				<div className="flex h-full flex-1 items-center px-2 text-[12px] text-muted-foreground">
					{t("topBar.emptyHint", "Select a session from the sidebar")}
				</div>
			)}
			{/* 便利贴快速记录按钮：点击展开悬浮便利贴 */}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="icon-sm"
						variant="ghost"
						data-sticky-toggle
						className={`absolute top-1/2 -translate-y-1/2 rounded-md border border-hairline ${
							rightPanelCollapsed ? "right-10" : "right-2"
						}`}
						onClick={() => appStore.set(stickyNoteExpandRequestAtom, (n) => n + 1)}
						aria-label={t("drafts.stickyHint")}
					>
						<StickyNote className="size-3.5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("drafts.stickyHint")}</TooltipContent>
			</Tooltip>
			{rightPanelCollapsed && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon-sm"
							variant="ghost"
							className="expand-right-panel-btn rounded-md border border-hairline"
							onClick={() => setRightPanelCollapsed(false)}
							aria-label={t("rightPanel.expand", "展开右侧面板")}
						>
							<PanelLeftOpen className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("rightPanel.expand", "展开右侧面板")}</TooltipContent>
				</Tooltip>
			)}
		</header>
	);
}
