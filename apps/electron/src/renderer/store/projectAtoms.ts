import type { FileTreeNode, GitRepoInfo, ProjectInfo } from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { toast } from "sonner";
import i18n from "../i18n";

export const projectsAtom = atom<ProjectInfo[]>([]);

export const activeProjectIdAtom = atom<string | null>(null);

export const openProjectIdsAtom = atom<string[]>([]);

export const openedSessionIdsAtom = atom<string[]>([]);

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

/** 右侧面板宽度（px），可拖拽把手调整，持久化到 ui-settings.json。默认 260。 */
export const rightPanelWidthAtom = atom(260);

/** Dock 文件面板宽度（px），可拖拽把手调整，持久化到 ui-settings.json。默认 420。 */
export const dockPanelWidthAtom = atom(420);

/** 通用设置（含面板宽度/折叠态）是否已从主进程加载完成；完成前 App 不持久化布局值，
 *  避免启动首帧把默认宽度写回设置覆盖用户已存值（2026-08-07）。 */
export const generalSettingsHydratedAtom = atom(false);

export const rightPanelTabAtom = atom<"shared" | "workspace" | "changes">("workspace");

export const showHiddenFilesAtom = atom(true);

/** 文件查看器当前目标；非 null 时 FileViewerDialog 打开。全局同时只查看一个文件。 */
export const viewingFileAtom = atom<{ absolutePath: string; diffPatch?: string } | null>(null);

/** 主窗口右侧 Dock 面板当前展示的文件；非 null 时 DockFilePanel 打开。 */
export const dockedFileAtom = atom<{ absolutePath: string; diffPatch?: string } | null>(null);

/** 聊天图片放大预览当前目标；非 null 时 ImagePreviewDialog 打开。 */
export const imagePreviewAtom = atom<{ src: string; alt: string } | null>(null);

/** 查看器内 md 编辑的脏状态镜像（由 FileViewerDialog 写入）。 */
export const fileViewerDirtyAtom = atom(false);

/** 外部入口替换 Dock 面板文件前的脏确认：有未保存修改时弹原生确认，取消返回 false。
 *  覆盖 requestViewFileAtom 与 fileViewer:docked 这两条不经过 FileViewerDialog
 *  requestClose/返回栈的跳转路径，杜绝静默丢草稿（2026-08-07 修复）。 */
export function confirmDockFileSwapIfDirty(getDirty: () => boolean): boolean {
	if (!getDirty()) return true;
	return window.confirm(i18n.t("fileViewer.unsavedConfirm"));
}

/**
 * 打开文件的统一入口:先 stat 再分流——目录在 Finder 中展示(不打开查看器),
 * 文件默认在主窗口右侧 Dock 面板中打开(2026-08-08 起不再默认弹独立窗口);
 * 需要独立窗口时用 Dock 面板的“弹出为独立窗口”或 dockFileViewer。
 * Dock 面板已有内容且存在未保存修改时先确认,避免静默覆盖。
 */
export const requestViewFileAtom = atom(null, async (get, set, absolutePath: string) => {
	const stat = await window.look.statFilePath(absolutePath).catch(() => null);
	// 项目外文件允许只读查看（2026-08-08 方案 B）:stat 不再因 "Path denied" 拒绝,
	// 查看器根据 inProject 标记禁用编辑/保存;目录仍走 Finder 展示。
	if (stat?.success && stat.kind === "directory") {
		void window.look.revealInFinder(absolutePath);
		return;
	}
	// 路径不存在(如聊天引用指向已删除/仅存在于其他机器的文件):
	// 直接 toast 友好提示,不打开一个必然加载失败的查看器。
	if (stat?.success && stat.kind === "missing") {
		toast.error(i18n.t("fileViewer.fileMissing"));
		return;
	}
	// Dock 面板已有未保存编辑时先确认，避免静默覆盖（2026-08-07）
	if (get(dockedFileAtom) && !confirmDockFileSwapIfDirty(() => get(fileViewerDirtyAtom))) return;
	set(dockedFileAtom, { absolutePath });
});

export const expandedWorkspacePathsAtomFamily = atomFamily((projectId: string) => atom<Set<string>>(new Set<string>()));

export const loadedWorkspaceChildrenAtomFamily = atomFamily((projectId: string) =>
	atom<Map<string, FileTreeNode[]>>(new Map<string, FileTreeNode[]>()),
);

export const selectedSharedPathAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

/** 共享区展开路径与懒加载缓存；根目录继续由 sharedFilesAtomFamily 提供。 */
export const expandedSharedPathsAtomFamily = atomFamily((projectId: string) => atom<Set<string>>(new Set<string>()));

export const loadedSharedChildrenAtomFamily = atomFamily((projectId: string) =>
	atom<Map<string, FileTreeNode[]>>(new Map<string, FileTreeNode[]>()),
);

/** 每个项目的 git 只读信息（GitStatusBar 订阅；null = 未加载/未知）。 */
export const projectGitInfoAtomFamily = atomFamily((projectId: string) => atom<GitRepoInfo | null>(null));

export const sharedFilesAtomFamily = atomFamily((projectId: string) => atom<FileTreeNode[]>([]));

export const sharedFilesLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

/** 根列表最近一次加载失败的错误信息；null = 无错误。 */
export const sharedFilesErrorAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

export const workspaceTreeLoadingAtomFamily = atomFamily((projectId: string) => atom(false));

export const workspaceTreeErrorAtomFamily = atomFamily((projectId: string) => atom<string | null>(null));

export function removeProjectAtoms(projectId: string): void {
	expandedWorkspacePathsAtomFamily.remove(projectId);
	loadedWorkspaceChildrenAtomFamily.remove(projectId);
	selectedSharedPathAtomFamily.remove(projectId);
	expandedSharedPathsAtomFamily.remove(projectId);
	loadedSharedChildrenAtomFamily.remove(projectId);
	projectGitInfoAtomFamily.remove(projectId);
	projectGitInfoAtomFamily.remove("");
	sharedFilesAtomFamily.remove(projectId);
	sharedFilesLoadingAtomFamily.remove(projectId);
	sharedFilesErrorAtomFamily.remove(projectId);
	workspaceTreeLoadingAtomFamily.remove(projectId);
	workspaceTreeErrorAtomFamily.remove(projectId);
}
