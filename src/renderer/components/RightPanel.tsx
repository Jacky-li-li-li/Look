// ============================================================
// RightPanel — 右侧边栏容器(v0.6:共享区 + 工作区 双 tab)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Separator } from "@shared/components/ui/separator";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Bot, PanelRightClose } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import {
	activeProjectAtom,
	rightPanelCollapsedAtom,
	rightPanelTabAtom,
	sharedFilesAtomFamily,
	sharedFilesLoadingAtomFamily,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import AgentMarketplacePanel from "./AgentMarketplace/AgentMarketplacePanel";
import { SharedAreaPanel } from "./SharedAreaPanel";
import { WorkspaceTreePanel } from "./WorkspaceTreePanel";

// 没有 active project 时使用的占位 projectId,避免 hook 调用顺序不稳定
const PLACEHOLDER_PROJECT_ID = "__right_panel_placeholder__";

export function RightPanel() {
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
	// 缓存非空时跳过主动拉取,完全依赖 shared:updated 事件刷新(M-1)。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const pid = projectId;
		// 缓存非空时跳过 — 切回已加载过的项目不会重复 fetch
		if (appStore.get(sharedFilesAtomFamily(pid)).length > 0) return;
		let cancelled = false;
		setIsLoading(true);
		window.look
			.listSharedFiles(pid)
			.then((result) => {
				if (cancelled) return;
				if (result?.success && result.nodes) {
					appStore.set(sharedFilesAtomFamily(pid), result.nodes);
				} else {
					toast.error(result?.error ?? "加载共享区失败");
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : "加载共享区失败";
				toast.error(message);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, setIsLoading]);

	// 启动 watcher;切项目或卸载时显式 stop,避免 chokidar 句柄累积(H-2)。
	useEffect(() => {
		if (projectId === PLACEHOLDER_PROJECT_ID) return;
		const pid = projectId;
		window.look.startSharedWatch(pid).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : "启动共享区监听失败";
			toast.error(message);
		});
		return () => {
			window.look.stopSharedWatch(pid).catch(() => {
				// best-effort:切换/卸载时旧 watcher 的停止失败不打扰用户
			});
		};
	}, [projectId]);

	if (!activeProject && tab !== "agents") return null;

	return (
		<>
			<Separator orientation="vertical" className="right-panel-separator mx-1 bg-transparent" />
			<aside
				className="right-panel-wrapper flex h-full shrink-0 flex-col overflow-hidden rounded-xl border bg-background"
				data-collapsed={collapsed}
				aria-label="右侧面板"
				inert={collapsed || undefined}
			>
				<header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
					<nav role="tablist" className="flex flex-1 gap-1" aria-label="右侧面板标签">
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
							工作区
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
							共享区
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "agents"}
							className={`flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
								tab === "agents"
									? "bg-foreground/10 text-foreground"
									: "text-muted-foreground hover:bg-foreground/5"
							}`}
							onClick={() => setTab("agents")}
						>
							<Bot className="mr-1 inline size-3" />
							Agents
						</button>
					</nav>
					<Button
						size="icon-sm"
						variant="ghost"
						className="shrink-0 rounded-md border border-hairline"
						onClick={() => setCollapsed(true)}
						aria-label="折叠右侧面板"
						title="折叠右侧面板"
					>
						<PanelRightClose className="size-3.5" />
					</Button>
				</header>
				{tab === "workspace" && activeProject && (
					<WorkspaceTreePanel projectId={activeProject.id} cwd={activeProject.cwd} />
				)}
				{tab === "agents" && <AgentMarketplacePanel />}
				{tab === "shared" && activeProject && (
					<SharedAreaPanel
						projectId={activeProject.id}
						files={sharedFiles}
						isLoading={isLoading}
						onAfterChange={async () => {
							const result = await window.look.listSharedFiles(activeProject!.id);
							if (result?.success && result.nodes) {
								appStore.set(sharedFilesAtomFamily(activeProject!.id), result.nodes);
							}
						}}
					/>
				)}
			</aside>
		</>
	);
}
