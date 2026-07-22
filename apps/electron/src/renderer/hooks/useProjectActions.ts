// ============================================================
// useProjectActions — 项目操作回调 + newProjectCwd 状态
// ============================================================

import type { ProjectInfo } from "@shared/types";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { activeAgentIdAtom, activeProjectIdAtom, pendingDeleteProjectAtom, projectsAtom } from "../store/atoms";
import { appStore } from "../store/ipcHandler";

const api = window.look;

export function useProjectActions() {
	const { t } = useTranslation();
	const [newProjectCwd, setNewProjectCwd] = useState<string | null>(null);

	const handleOpenProject = useCallback(async () => {
		if (!api) return;
		const result = await api.openDirectoryDialog(t("project.openProject", "Open project folder"));
		if (!result?.success || !result.path) return;
		setNewProjectCwd(result.path);
	}, [t]);

	const handleDeleteProject = useCallback((project: ProjectInfo) => {
		api.deleteProject(project.id);
	}, []);

	const handleProjectCreated = useCallback(async (projectId: string) => {
		appStore.set(activeProjectIdAtom, projectId);
		appStore.set(activeAgentIdAtom, null);
		const r = await api.listProjects().catch(() => null);
		if (r?.success) {
			appStore.set(projectsAtom, r.projects);
		}
	}, []);

	const handleDeleteProjectCancelled = useCallback(() => {
		appStore.set(pendingDeleteProjectAtom, null);
	}, []);

	const handleDeleteProjectConfirmed = useCallback(() => {
		appStore.set(pendingDeleteProjectAtom, null);
		api.listProjects()
			.then((r) => {
				if (r?.success) appStore.set(projectsAtom, r.projects);
			})
			.catch((err) => console.warn("[useProjectActions] refreshProjects failed:", err));
	}, []);

	const handleRenameProject = useCallback(async (projectId: string, name: string) => {
		if (!api || !name.trim()) return;
		const result = await api.renameProject(projectId, name.trim());
		if (!result?.success) toast.error(result?.error ?? "Failed to rename project");
	}, []);

	const handleOpenProjectFolderById = useCallback(async (projectId: string) => {
		if (!api) return;
		const result = await api.openProjectFolder(projectId).catch(() => null);
		if (!result?.success) toast.error(result?.error ?? "Failed to open project folder");
	}, []);

	return {
		newProjectCwd,
		setNewProjectCwd,
		handleOpenProject,
		handleDeleteProject,
		handleProjectCreated,
		handleDeleteProjectCancelled,
		handleDeleteProjectConfirmed,
		handleRenameProject,
		handleOpenProjectFolderById,
	};
}
