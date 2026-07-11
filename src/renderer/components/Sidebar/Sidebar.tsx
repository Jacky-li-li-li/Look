// ============================================================
// Sidebar — 主编排组件（Header + ProjectTree + Footer）
// ============================================================

import { Button } from "@shared/components/ui/button";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { useAtomValue } from "jotai";
import { FolderOpen, PanelLeftClose, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectsAtom, rightPanelCollapsedAtom, showAgentSquareAtom, sidebarCollapsedAtom } from "../../store/atoms";
import { userProfileAtom } from "../../store/authAtoms";
import { appStore } from "../../store/ipcHandler";
import { UserAvatar } from "@shared/components/UserAvatar";
import ProjectTree from "./ProjectTree";
import type { SidebarProps } from "./types";

export default function Sidebar({
	onSelect,
	onDestroy,
	onCreateClick,
	onSettingsClick,
	onCreateProject,
	onDeleteProject,
	onOpenProject,
	onRenameProject,
}: SidebarProps) {
	const { t } = useTranslation();
	const projects = useAtomValue(projectsAtom);
	const userProfile = useAtomValue(userProfileAtom);
	const collapsed = useAtomValue(sidebarCollapsedAtom);

	return (
		<aside
			className="workspace-ledger glass-panel sidebar-wrapper flex h-full shrink-0 flex-col overflow-hidden rounded-xl border"
			data-collapsed={collapsed}
		>
			<header className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-3">
				<div className="min-w-0">
					<div className="text-sm font-bold tracking-[0.2em] text-foreground">LOOK</div>
					<div className="mt-0.5 font-mono text-[9px] text-muted-foreground/55">
						{projects.length.toString().padStart(2, "0")} {t("workspace.projects", "projects")}
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						variant="line-ghost"
						size="icon-sm"
						className="border border-hairline rounded-md"
						onClick={onCreateProject}
						aria-label={t("project.openProject", "Add project folder")}
						title={t("project.openProject", "Add project folder")}
					>
						<FolderOpen className="size-3.5" />
						<Plus className="absolute ml-3 mt-3 size-2.5 rounded-full bg-sidebar" />
					</Button>
					<Button
						variant="line-ghost"
						size="icon-sm"
						className="border border-hairline rounded-md"
						onClick={() => appStore.set(sidebarCollapsedAtom, true)}
						aria-label={t("sidebar.collapse", "Collapse sidebar")}
						title={t("sidebar.collapse", "Collapse sidebar")}
					>
						<PanelLeftClose className="size-3.5" />
					</Button>
				</div>
			</header>

			<ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden" type="always">
				<div className="space-y-1.5 px-2 py-2">
					<ProjectTree
						onSelect={onSelect}
						onDestroy={onDestroy}
						onCreateClick={onCreateClick}
						onDeleteProject={onDeleteProject}
						onOpenProject={onOpenProject}
						onRenameProject={onRenameProject}
					/>
				</div>
			</ScrollArea>

			<button
				type="button"
				onClick={() => {
					appStore.set(showAgentSquareAtom, true);
					appStore.set(rightPanelCollapsedAtom, true);
				}}
				className="group flex h-10 shrink-0 items-center gap-2.5 border-t border-hairline px-3 text-left transition-colors hover:bg-foreground/[0.02]"
				title={t("marketplace.title")}
			>
				<span className="text-[9px] leading-none text-foreground/25 transition-all duration-500 group-hover:text-foreground/50">
					◆
				</span>
				<span className="text-[11px] font-normal tracking-[0.03em] text-foreground/[0.52]">
					{t("marketplace.title")}
				</span>
			</button>

			<button
				type="button"
				onClick={onSettingsClick}
				className="flex h-11 shrink-0 items-center gap-2 border-t border-hairline px-3 text-left transition-colors hover:bg-foreground/[0.035]"
			>
				<UserAvatar avatar={userProfile.avatar} size="sm" />
				<span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
					{userProfile.userName || "You"}
				</span>
				<span className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground/45">
					{t("sidebar.settings", "Settings")}
				</span>
			</button>
		</aside>
	);
}
