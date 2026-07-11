// ============================================================
// Sidebar/ProjectHeader — 项目头部（折叠/编辑/操作菜单）
// ============================================================

import { Button } from "@shared/components/ui/button";
import { CollapsibleTrigger } from "@shared/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import { cn } from "@shared/lib/utils";
import { DEFAULT_PROJECT_ID } from "@shared/types";
import { AlertTriangle, ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProjectHeaderProps } from "./types";
import { shortenPath } from "./utils";

export default function ProjectHeader({
	project,
	isOpen,
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
		<div className="group/project flex h-10 items-center gap-1 rounded-lg px-1 transition-colors hover:bg-foreground/[0.035]">
			<CollapsibleTrigger asChild>
				<button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left">
					<ChevronRight
						className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
					/>
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
								aria-label="编辑项目名称"
								value={editValue}
								onChange={(event) => setEditValue(event.target.value)}
								onBlur={commitEdit}
								onKeyDown={handleEditKeyDown}
								onClick={(event) => event.stopPropagation()}
								className="w-full border-b border-foreground/40 bg-transparent text-[12px] font-semibold outline-none"
								maxLength={64}
							/>
						) : (
							<span
								className="block truncate text-[12px] font-semibold"
								onDoubleClick={
									isDefault
										? undefined
										: (event) => {
												event.stopPropagation();
												beginEdit("project", project.id, project.name);
											}
								}
							>
								{project.name}
							</span>
						)}
						<span className="block truncate font-mono text-[9px] leading-tight text-muted-foreground/55">
							{shortenPath(project.cwd, homedir)}
						</span>
					</span>
				</button>
			</CollapsibleTrigger>
			<Button
				variant="line-ghost"
				size="icon-xs"
				className="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
				disabled={!project.valid}
				onClick={() => onCreateClick(project.id)}
				aria-label={t("sidebar.newSession", "New session")}
			>
				<Plus className="size-3" />
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="line-ghost"
						size="icon-xs"
						className="opacity-0 group-hover/project:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
						aria-label={t("workspace.projectMenu", "Project menu")}
					>
						<MoreHorizontal className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					{!isDefault && (
						<DropdownMenuItem onSelect={() => onOpenProject(project.id)} className="gap-2 text-[12px]">
							<FolderOpen className="size-3.5" /> {t("workspace.openFolder", "Open folder")}
						</DropdownMenuItem>
					)}
					{!isDefault && (
						<DropdownMenuItem
							onSelect={() => beginEdit("project", project.id, project.name)}
							className="gap-2 text-[12px]"
						>
							<Pencil className="size-3.5" /> {t("sidebar.rename", "Rename")}
						</DropdownMenuItem>
					)}
					{!isDefault && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onSelect={() => onDeleteProject(project)}
								className="gap-2 text-[12px]"
							>
								<Trash2 className="size-3.5" /> {t("project.delete", "Delete project")}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
