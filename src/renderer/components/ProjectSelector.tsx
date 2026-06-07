// ============================================================
// ProjectSelector — project switcher in sidebar header
// ============================================================

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import { cn } from "@shared/lib/utils";
import type { ProjectInfo } from "@shared/types";
import { AlertTriangle, Check, ChevronDown, Folder, FolderOpen, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

const api = (window as any).look;

interface ProjectSelectorProps {
	projects: ProjectInfo[];
	activeProjectId: string | null;
	onSelectProject: (projectId: string) => void;
	onCreateProject: () => void;
	onDeleteProject: (project: ProjectInfo) => void;
}

function shortenPath(cwd: string, homedir: string): string {
	if (homedir && cwd.startsWith(homedir)) {
		return "~" + cwd.slice(homedir.length);
	}
	return cwd;
}

export default function ProjectSelector({
	projects,
	activeProjectId,
	onSelectProject,
	onCreateProject,
	onDeleteProject,
}: ProjectSelectorProps) {
	const { t } = useTranslation();
	const homedir = (window as any).look?.homedir || "";

	const activeProject = projects.find((p) => p.id === activeProjectId);

	return (
		<div className="flex shrink-0 items-center gap-1 border-b border-hairline px-3 py-2">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
					>
						{activeProject ? (
							<Folder className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
						)}
						<div className="min-w-0 flex-1">
							<div className="truncate text-[13px] font-medium leading-tight">
								{activeProject?.name ?? t("project.noProject", "No project")}
							</div>
							{activeProject && (
								<div className="truncate text-[10px] text-muted-foreground/60 leading-tight">
									{shortenPath(activeProject.cwd, homedir)}
								</div>
							)}
						</div>
						<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
					</button>
				</DropdownMenuTrigger>

				<DropdownMenuContent align="start" sideOffset={6} className="w-[260px]">
					{projects.length === 0 ? (
						<div className="px-2 py-3 text-center text-xs text-muted-foreground">
							{t("project.noProjects", "No projects yet")}
						</div>
					) : (
						projects.map((p) => (
							<DropdownMenuItem
								key={p.id}
								onSelect={() => {
									if (p.valid) onSelectProject(p.id);
								}}
								className={cn("flex items-center gap-2 px-2 py-1.5", !p.valid && "opacity-50 cursor-default")}
							>
								{p.valid ? (
									<Folder className="size-4 shrink-0 text-muted-foreground" />
								) : (
									<AlertTriangle className="size-4 shrink-0 text-amber-500" />
								)}
								<div className="min-w-0 flex-1">
									<div className="truncate text-[13px]">{p.name}</div>
									<div className="truncate text-[10px] text-muted-foreground/60">
										{shortenPath(p.cwd, homedir)}
									</div>
								</div>
								{p.id === activeProjectId && <Check className="size-3.5 shrink-0 text-foreground" />}
								<button
									type="button"
									className="ml-auto flex shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
									style={{ opacity: undefined }}
									onClick={(e) => {
										e.stopPropagation();
										onDeleteProject(p);
									}}
									title={
										p.valid
											? t("project.delete", "Delete project")
											: t("project.pathMissing", "Project path does not exist")
									}
								>
									<X className="size-3 text-muted-foreground hover:text-red-500" />
								</button>
							</DropdownMenuItem>
						))
					)}

					<DropdownMenuSeparator />

					<DropdownMenuItem
						onSelect={onCreateProject}
						className="flex items-center gap-2 px-2 py-1.5 text-[13px] font-medium"
					>
						<Plus className="size-4" />
						{t("project.openProject", "Open Project...")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<button
				type="button"
				onClick={onCreateProject}
				className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				title={t("project.openProject", "Open Project")}
			>
				<Plus className="size-4" />
			</button>
		</div>
	);
}
