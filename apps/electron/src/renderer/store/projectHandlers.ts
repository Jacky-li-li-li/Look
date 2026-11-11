import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import {
	activeProjectIdAtom,
	appReadyPhaseAtom,
	loadedWorkspaceChildrenAtomFamily,
	openProjectIdsAtom,
	pendingDeleteProjectAtom,
	projectGitInfoAtomFamily,
	projectsAtom,
	removeProjectAtoms,
	showHiddenFilesAtom,
} from "./atoms";

export function handleProjectEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "project:list": {
			const previous = appStore.get(projectsAtom);
			const previousIds = new Set(previous.map((project) => project.id));
			appStore.set(projectsAtom, event.projects);
			if (appStore.get(appReadyPhaseAtom) < 1) appStore.set(appReadyPhaseAtom, 1);
			const projectIds = new Set(event.projects.map((project) => project.id));
			appStore.set(
				openProjectIdsAtom,
				appStore.get(openProjectIdsAtom).filter((projectId) => projectIds.has(projectId)),
			);
			for (const projectId of previousIds) {
				if (!projectIds.has(projectId)) removeProjectAtoms(projectId);
			}
			if (event.activeProjectId !== undefined) {
				appStore.set(activeProjectIdAtom, event.activeProjectId);
			}
			return true;
		}

		case "project:active-changed":
			appStore.set(activeProjectIdAtom, event.projectId);
			return true;

		case "project:git-info": {
			// 主进程 HEAD watcher 推送（外部 git checkout 等）：直接更新 atom，无需重新 invoke。
			appStore.set(projectGitInfoAtomFamily(event.projectId), event.info);
			return true;
		}

		case "project:confirm-delete":
			appStore.set(pendingDeleteProjectAtom, {
				projectId: event.projectId,
				projectName: event.projectName,
				agentCount: event.agentCount,
				runningCount: event.runningCount,
			});
			return true;

		case "workspace:updated": {
			const { projectId, relativePath } = event;
			const loadedAtom = loadedWorkspaceChildrenAtomFamily(projectId);
			if (!appStore.get(loadedAtom).has(relativePath)) return true;
			void window.look
				.listWorkspaceChildren(projectId, relativePath, appStore.get(showHiddenFilesAtom))
				.then((result) => {
					if (result?.success && result.nodes) {
						appStore.set(loadedAtom, (prev) => {
							const next = new Map(prev);
							next.set(relativePath, result.nodes ?? []);
							return next;
						});
					} else {
						console.error(
							`[WorkspaceTree] Watcher refresh failed for ${projectId}/${relativePath}: ${result?.error ?? "unknown error"}`,
						);
					}
				})
				.catch((err: unknown) => {
					console.error(`[WorkspaceTree] Watcher refresh exception for ${projectId}/${relativePath}:`, err);
				});
			return true;
		}

		default:
			return false;
	}
}
