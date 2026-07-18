import type { FileTreeNode, ProjectInfo } from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export const projectsAtom = atom<ProjectInfo[]>([]);

export const activeProjectIdAtom = atom<string | null>(null);

export const openProjectIdsAtom = atom<string[]>([]);

export const openedSessionIdsAtom = atom<string[]>([]);

export const recentlyActiveSessionIdsAtom = atom<string[]>([]);

export const pendingDeleteProjectAtom = atom<{
	projectId: string;
	projectName: string;
	agentCount: number;
	runningCount: number;
} | null>(null);

export const activeProjectAtom = atom((get) => {
	const projects = get(projectsAtom);
	const id = get(activeProjectIdAtom);
	return id ? (projects.find((p) => p.id === id) ?? null) : null;
});

export const rightPanelCollapsedAtom = atom(false);

export const rightPanelTabAtom = atom<"shared" | "workspace">("workspace");

export const showHiddenFilesAtom = atom(false);

/** 文件查看器当前目标；非 null 时 FileViewerDialog 打开。全局同时只查看一个文件。 */
export const viewingFileAtom = atom<{ absolutePath: string } | null>(null);

/** 查看器内 md 编辑的脏状态镜像（由 FileViewerDialog 写入）。 */
export const fileViewerDirtyAtom = atom(false);

/** 打开文件的统一入口:在独立的原生查看器窗口中打开(脏确认由查看器窗口自理)。 */
export const requestViewFileAtom = atom(null, (_get, _set, absolutePath: string) => {
	void window.look.openFileViewer(absolutePath);
});

export const expandedWorkspacePathsAtomFamily = atomFamily((projectId: string) => atom<Set<string>>(new Set<string>()));

export const loadedWorkspaceChildrenAtomFamily = atomFamily((projectId: string) =>
	atom<Map<string, FileTreeNode[]>>(new Map<string, FileTreeNode[]>()),
);

export const selectedSharedPathAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

export const sharedFilesAtomFamily = atomFamily((projectId: string) => atom<FileTreeNode[]>([]));

export const sharedFilesLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

export const workspaceTreeLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

export const workspaceTreeErrorAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

export function removeProjectAtoms(projectId: string): void {
	expandedWorkspacePathsAtomFamily.remove(projectId);
	loadedWorkspaceChildrenAtomFamily.remove(projectId);
	selectedSharedPathAtomFamily.remove(projectId);
	sharedFilesAtomFamily.remove(projectId);
	sharedFilesLoadingAtomFamily.remove(projectId);
	workspaceTreeLoadingAtomFamily.remove(projectId);
	workspaceTreeErrorAtomFamily.remove(projectId);
}
