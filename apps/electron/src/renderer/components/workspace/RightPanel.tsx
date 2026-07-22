// ============================================================
// RightPanel — 右侧边栏容器(v0.6:共享区 + 工作区 双 tab)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { PanelRightClose } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
	activeProjectAtom,
	rightPanelCollapsedAtom,
	rightPanelTabAtom,
	sharedFilesAtomFamily,
	sharedFilesLoadingAtomFamily,
} from "../../store/atoms";
import { appStore } from "../../store/ipcHandler";
import { SharedAreaPanel } from "./SharedAreaPanel";
import { WorkspaceTreePanel } from "./WorkspaceTreePanel";

// 没有 active project 时使用的占位 projectId,避免 hook 调用顺序不稳定
const PLACEHOLDER_PROJECT_ID = "__right_panel_placeholder__";

export function RightPanel() {
	const { t } = useTranslation();
	const activeProject = useAtomValue(activeProjectAtom);
	const collapsed = useAtomValue(rightPanelCollapsedAtom);
	const [tab, setTab] = useAtom(rightPanelTabAtom);
	const setCollapsed = useSetAtom(rightPanelCollapsedAtom);
	const projectId = activeProject?.id ?? PLACEHOLDER_PROJECT_ID;

	// 始终调用 hooks;在 effect 内判断 projectId 是否有效
	const filesAtom = sharedFilesAtomFamily(projectId);
	const loadingAtom = sharedFilesLoadingAtomFamily(projectId);
	const sharedFiles = useAtomValue(filesAtom);
	const isLoading = useAtomValue(loadingAtom);
	const setIsLoading = useSetAtom(loadingAtom);

	// 切换项目时拉取新文件树(占位 projectId 时跳过)。
	// 缓存非空时跳过主动拉取;watcher 按项目常驻,shared:updated 事件会持续刷新缓存(M-1)。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const pid = projectId;
		// 缓存非空时跳过 — 切回已加载过的项目不会重复 fetch
		// (常驻 watcher 保证离开期间的改动也会通过 shared:updated 写入缓存,不会过期)
		if (appStore.get(sharedFilesAtomFamily(pid)).length > 0) return;
		let cancelled = false;
		setIsLoading(true);
		window.look
			.listSharedFiles(pid)
			.then((result) => {
				if (cancelled) return;
				if (result?.success) {
					appStore.set(sharedFilesAtomFamily(pid), result.nodes ?? []);
				} else {
					toast.error(result?.error ?? t("rightPanel.loadFailed"));
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : t("rightPanel.loadFailed");
				toast.error(message);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, setIsLoading, t]);

	// 启动共享区 watcher。watcher 按项目常驻,切项目时不在此处 stop:
	// 主进程 startWatching 幂等,离开期间的改动仍会通过 shared:updated 刷新缓存,
	// 项目删除时由主进程 project-deletion-service 统一 stopWatching(H-2)。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const pid = projectId;
		window.look
			.startSharedWatch(pid)
			.then((result) => {
				if (!result?.success) toast.error(result?.error ?? t("rightPanel.watchFailed"));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : t("rightPanel.watchFailed");
				toast.error(message);
			});
	}, [projectId, t]);

	if (!activeProject) return null;

	return (
		<aside
			className="right-panel-wrapper flex h-full shrink-0 flex-col overflow-hidden rounded-xl border bg-background"
			data-collapsed={collapsed}
			aria-label={t("rightPanel.label")}
			inert={collapsed || undefined}
		>
			<header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
				<div role="tablist" className="flex flex-1 gap-1" aria-label={t("rightPanel.tabsLabel")}>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "workspace"}
						className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							tab === "workspace"
								? "bg-foreground/10 text-foreground"
								: "text-muted-foreground hover:bg-foreground/5"
						}`}
						onClick={() => setTab("workspace")}
					>
						{t("rightPanel.workspace")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "shared"}
						className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							tab === "shared"
								? "bg-foreground/10 text-foreground"
								: "text-muted-foreground hover:bg-foreground/5"
						}`}
						onClick={() => setTab("shared")}
					>
						{t("rightPanel.shared")}
					</button>
				</div>
				<Button
					size="icon-sm"
					variant="ghost"
					className="shrink-0 rounded-md border border-hairline"
					onClick={() => setCollapsed(true)}
					aria-label={t("rightPanel.collapse")}
					title={t("rightPanel.collapse")}
				>
					<PanelRightClose className="size-3.5" />
				</Button>
			</header>
			{tab === "workspace" && activeProject && (
				<WorkspaceTreePanel projectId={activeProject.id} cwd={activeProject.cwd} />
			)}
			{tab === "shared" && activeProject && (
				<SharedAreaPanel
					projectId={activeProject.id}
					files={sharedFiles}
					isLoading={isLoading}
					onAfterChange={async () => {
						const result = await window.look.listSharedFiles(activeProject!.id);
						if (!result?.success) throw new Error(result?.error ?? t("rightPanel.loadFailed"));
						appStore.set(sharedFilesAtomFamily(activeProject!.id), result.nodes ?? []);
					}}
				/>
			)}
		</aside>
	);
}
