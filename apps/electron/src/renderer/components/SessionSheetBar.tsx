// ============================================================
// SessionSheetBar — Multi-session sheet tabs in the top bar
// ============================================================

import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { AgentInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { PanelLeftOpen, PanelRightOpen, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { sessionStateAtomFamily } from "../store/atoms";
import { deriveAgentPhase, deriveSessionPhase } from "../store/sessionTypes";

interface SessionSheet {
	id: string;
	agent: AgentInfo | undefined;
	projectName: string | undefined;
}

interface SessionSheetBarProps {
	agentIds: string[];
	agents: AgentInfo[];
	projects: { id: string; name: string }[];
	activeAgentId: string | null;
	sidebarCollapsed: boolean;
	rightPanelCollapsed: boolean;
	onSelect: (agentId: string) => void;
	onClose: (agentId: string) => void;
	onReorder: (agentIds: string[]) => void;
	onExpandSidebar: () => void;
	onExpandRightPanel: () => void;
}

function SortableSheet({
	sheet,
	isActive,
	onSelect,
	onClose,
}: {
	sheet: SessionSheet;
	isActive: boolean;
	onSelect: (agentId: string) => void;
	onClose: (agentId: string) => void;
}) {
	const { t } = useTranslation();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: sheet.id,
		data: { sheet },
	});

	const agent = sheet.agent;
	const statePhase = useAtomValue(sessionStateAtomFamily(sheet.id));
	const derivedPhase = deriveSessionPhase(statePhase);
	const status = derivedPhase === "idle" ? deriveAgentPhase(agent) : derivedPhase;
	const isRunning = status !== "idle";

	const handleClose = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation();
			onClose(sheet.id);
		},
		[onClose, sheet.id],
	);

	const style = {
		transform: CSS.Translate.toString(transform),
		transition,
		zIndex: isDragging ? 50 : undefined,
	};

	return (
		<>
			{/* react-doctor-disable-next-line prefer-tag-over-role -- dnd-kit sortable 默认使用 role=button，且内部嵌套关闭按钮，不适合改为 button */}
			<div
				ref={setNodeRef}
				style={style}
				{...attributes}
				{...listeners}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelect(sheet.id);
					}
				}}
				data-agent-id={sheet.id}
				data-agent-status={status}
				data-running={isRunning || undefined}
				className={cn(
					"group/sheet relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors",
					isActive
						? "border-accent/80 bg-accent text-foreground"
						: "border-hairline bg-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
					isDragging && "opacity-60",
				)}
				onClick={() => onSelect(sheet.id)}
			>
				{isRunning && <span className="status-mark block" data-status={status} />}
				<span className="truncate font-medium">{agent?.name ?? t("sheet.unknownSession", "Unknown")}</span>
				{sheet.projectName && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="max-w-24 truncate rounded bg-muted px-1 py-0 text-[10px] text-muted-foreground">
								{sheet.projectName}
							</span>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="text-xs">
							{sheet.projectName}
						</TooltipContent>
					</Tooltip>
				)}
				<Button
					variant="ghost"
					size="icon-xs"
					className="-mr-1 size-5 opacity-0 transition-opacity group-hover/sheet:opacity-100 focus-visible:opacity-100 group-focus-visible/sheet:opacity-100 data-[active]:opacity-100"
					data-active={isActive || undefined}
					aria-label={t("sheet.close", "Close session sheet")}
					title={t("sheet.close", "Close session sheet")}
					onClick={handleClose}
				>
					<X className="size-3" />
				</Button>
			</div>
		</>
	);
}

export default function SessionSheetBar({
	agentIds,
	agents,
	projects,
	activeAgentId,
	sidebarCollapsed,
	rightPanelCollapsed,
	onSelect,
	onClose,
	onReorder,
	onExpandSidebar,
	onExpandRightPanel,
}: SessionSheetBarProps) {
	const { t } = useTranslation();

	const agentById = useMemo(() => {
		const map = new Map<string, AgentInfo>();
		for (const agent of agents) map.set(agent.id, agent);
		return map;
	}, [agents]);

	const projectById = useMemo(() => {
		const map = new Map<string, string>();
		for (const project of projects) map.set(project.id, project.name);
		return map;
	}, [projects]);

	const sheets = useMemo<SessionSheet[]>(() => {
		return agentIds.map((id) => {
			const agent = agentById.get(id);
			const projectName = agent?.projectId ? projectById.get(agent.projectId) : undefined;
			return { id, agent, projectName };
		});
	}, [agentIds, agentById, projectById]);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	// When the active sheet changes, scroll it into view only if it's
	// currently off-screen. With `inline: "nearest"` the browser leaves the
	// scroll position alone when the active tab is already visible, so the
	// tab bar never jumps on click.
	useEffect(() => {
		if (!activeAgentId) return;
		const frame = requestAnimationFrame(() => {
			const root = scrollContainerRef.current;
			if (!root) return;
			const active = root.querySelector<HTMLElement>(`[data-agent-id="${activeAgentId}"]`);
			if (!active) return;
			const rootRect = root.getBoundingClientRect();
			const activeRect = active.getBoundingClientRect();
			if (activeRect.left < rootRect.left || activeRect.right > rootRect.right) {
				active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [activeAgentId]);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (over && active.id !== over.id) {
				const oldIndex = agentIds.indexOf(active.id as string);
				const newIndex = agentIds.indexOf(over.id as string);
				if (oldIndex !== -1 && newIndex !== -1) {
					onReorder(arrayMove(agentIds, oldIndex, newIndex));
				}
			}
		},
		[agentIds, onReorder],
	);

	return (
		<header
			className={cn(
				"app-drag flex h-12 shrink-0 items-center gap-2 border-b border-hairline",
				rightPanelCollapsed ? "px-2" : "pl-2",
				// 侧栏折叠时红绿灯会压到展开按钮，macOS 非全屏时让出左侧位置
				sidebarCollapsed && "mac-titlebar-pad",
			)}
		>
			{sidebarCollapsed && (
				<Button
					size="icon-sm"
					variant="ghost"
					className="expand-sidebar-btn shrink-0 rounded-md border border-hairline"
					onClick={onExpandSidebar}
					aria-label={t("sidebar.expand", "Expand sidebar")}
					title={t("sidebar.expand", "Expand sidebar")}
				>
					<PanelRightOpen className="size-3.5" />
				</Button>
			)}
			{sheets.length === 0 ? (
				<div className="flex h-full flex-1 items-center px-2 text-[12px] text-muted-foreground">
					{t("sheet.emptyHint", "Select a session from the sidebar")}
				</div>
			) : (
				<div
					ref={scrollContainerRef}
					className="app-no-drag min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
				>
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
						modifiers={[restrictToHorizontalAxis]}
					>
						<SortableContext items={sheets.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
							<div className="flex h-12 items-center gap-1.5 px-0 py-2">
								{sheets.map((sheet) => (
									<SortableSheet
										key={sheet.id}
										sheet={sheet}
										isActive={sheet.id === activeAgentId}
										onSelect={onSelect}
										onClose={onClose}
									/>
								))}
							</div>
						</SortableContext>
					</DndContext>
				</div>
			)}
			{rightPanelCollapsed && (
				<Button
					size="icon-sm"
					variant="ghost"
					className="expand-right-panel-btn shrink-0 rounded-md border border-hairline"
					onClick={onExpandRightPanel}
					aria-label={t("rightPanel.expand", "展开右侧面板")}
					title={t("rightPanel.expand", "展开右侧面板")}
				>
					<PanelLeftOpen className="size-3.5" />
				</Button>
			)}
		</header>
	);
}
