import type { MainToRendererEvent } from "@shared/types";
import { toast } from "sonner";
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
	sharedFilesAtomFamily,
	showHiddenFilesAtom,
} from "./atoms";

export function handleProjectEvent(
	event: MainToRendererEvent,
	sharedRefreshTimers: Map<string, ReturnType<typeof setTimeout>>,
): boolean {
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
				if (!projectIds.has(projectId)) {
					removeProjectAtoms(projectId);
					const pendingTimer = sharedRefreshTimers.get(projectId);
					if (pendingTimer) {
						clearTimeout(pendingTimer);
						sharedRefreshTimers.delete(projectId);
					}
				}
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

		case "shared:updated": {
			const projectId = event.projectId;
			const filesAtom = sharedFilesAtomFamily(projectId);
			const existing = sharedRefreshTimers.get(projectId);
			if (existing) clearTimeout(existing);
			sharedRefreshTimers.set(
				projectId,
				setTimeout(() => {
					sharedRefreshTimers.delete(projectId);
					void window.look
						.listSharedFiles(projectId)
						.then((result) => {
							if (result?.success && result.nodes) {
								appStore.set(filesAtom, result.nodes);
							} else if (result && !result.success) {
								toast.error(result.error ?? "刷新共享区失败");
							}
						})
						.catch((error: unknown) => {
							const message = error instanceof Error ? error.message : "刷新共享区失败";
							toast.error(message);
						});
				}, 200),
			);
			return true;
		}

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
