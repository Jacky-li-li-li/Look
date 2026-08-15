// ============================================================
// Sidebar/ProjectHeader — 项目头部（折叠/编辑/操作菜单）
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { CollapsibleTrigger } from "@look/ui/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@look/ui/components/ui/dropdown-menu";
import { DEFAULT_PROJECT_ID } from "@shared/types";
import { AlertTriangle, ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProjectHeaderProps } from "./types";
import { shortenPath } from "./utils";

export default function ProjectHeader({
	project,
	isOpen,
	isActive,
	runningCount,
	hasError,
	sessionCount,
	onSelectProject,
	editingProjectId,
	editRef,
	editValue,
	setEditValue,
	commitEdit,
	handleEditKeyDown,
	beginEdit,
	onCreateClick,
	onOpenProject,
	onDeleteProject,
}: ProjectHeaderProps) {
	const { t } = useTranslation();
	const isDefault = project.id === DEFAULT_PROJECT_ID;
	const homedir = window.look?.homedir || "";
	return (
		<div
			className="workspace-project-header group/project flex h-10 items-center gap-1 rounded-lg px-1 transition-colors"
			data-active={isActive || undefined}
			data-running={runningCount > 0 || undefined}
			data-error={hasError || undefined}
		>
			{/* 折叠/展开只由箭头触发；点击项目主体仅切换项目，不再折叠——否则
			    点击已展开项目会先收起（下方行上移）再被 auto-expand 重新展开（下移），
			    产生两段式跳动（2026-08 修复）。 */}
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
					aria-label={
						isOpen
							? t("workspace.collapseProject", "Collapse project")
							: t("workspace.expandProject", "Expand project")
					}
				>
					<ChevronRight
						className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
					/>
				</button>
			</CollapsibleTrigger>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-2 text-left"
				onClick={() => void onSelectProject(project.id)}
				title={shortenPath(project.cwd, homedir)}
			>
				<span className="workspace-folder-mark relative">
					{project.valid ? (
						<>
							<Folder
								className={cn(
									"size-3.5 absolute inset-0 m-auto transition-all duration-300",
									isOpen ? "scale-0 opacity-0" : "scale-100 opacity-100",
								)}
							/>
							<FolderOpen
								className={cn(
									"size-3.5 absolute inset-0 m-auto transition-all duration-300",
									isOpen ? "scale-100 opacity-100" : "scale-0 opacity-0",
								)}
							/>
						</>
					) : (
						<AlertTriangle className="size-3.5" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					{editingProjectId === project.id ? (
						<input
							ref={editRef}
							aria-label={t("sidebar.editProjectName", "编辑项目名称")}
							value={editValue}
							onChange={(event) => setEditValue(event.target.value)}
							onBlur={commitEdit}
							onKeyDown={handleEditKeyDown}
							onClick={(event) => event.stopPropagation()}
							className="w-full border-b border-foreground/40 bg-transparent text-[13px] font-semibold outline-none"
							maxLength={64}
						/>
					) : (
						<span className="block truncate text-[13px] font-semibold" title={project.name}>
							{project.name}
						</span>
					)}
					<span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground/55">
						{shortenPath(project.cwd, homedir)}
					</span>
				</span>
			</button>
			<span
				className="workspace-session-count shrink-0"
				aria-label={t("workspace.sessionCount", { count: sessionCount, defaultValue: "{{count}} sessions" })}
			>
				{sessionCount}
			</span>
			{runningCount > 0 && (
				<span
					className="workspace-live-count shrink-0"
					aria-label={t("workspace.runningCount", { count: runningCount, defaultValue: "{{count}} running" })}
				>
					{runningCount}
				</span>
			)}
			<Button
				variant="line-ghost"
				size="icon-xs"
				className="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
				disabled={!project.valid}
				onClick={() => onCreateClick(project.id)}
				aria-label={t("sidebar.newSession", "New session")}
				title={t("sidebar.newSession", "New session")}
			>
				<Plus className="size-3" />
			</Button>
			{!isDefault && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="line-ghost"
							size="icon-xs"
							className="opacity-0 group-hover/project:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
							aria-label={t("workspace.projectMenu", "Project menu")}
							title={t("workspace.projectMenu", "Project menu")}
						>
							<MoreHorizontal className="size-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
						<DropdownMenuItem onSelect={() => onOpenProject(project.id)} className="gap-2 text-[12.5px]">
							<FolderOpen className="size-3.5" /> {t("workspace.openFolder", "Open folder")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => beginEdit("project", project.id, project.name)}
							className="gap-2 text-[12.5px]"
						>
							<Pencil className="size-3.5" /> {t("sidebar.rename", "Rename")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => onDeleteProject(project)}
							className="gap-2 text-[12.5px]"
						>
							<Trash2 className="size-3.5" /> {t("project.delete", "Delete project")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
