// ============================================================
// WorkspaceTreePanel — 项目 cwd 文件树面板(v0.6)
//
// 设计灵感:
//   - VSCode IAsyncDataSource:hasChildren 同步基于 isDirectory,
//     getChildren 异步懒加载(VSCode 模式)
//   - Proma ignore 硬编码 4 套 Set + 文件名同步过滤
//   - chokidar watcher 仅监听用户已展开的目录(VSCode 模式)
//
// 状态模型:
//   - 展开集合 expandedWorkspacePathsAtomFamily(projectId) → Set<string>
//   - 加载缓存 loadedWorkspaceChildrenAtomFamily(projectId) → Map<parentPath, FileTreeNode[]>
//   - 工作区节点 → children 数组,空数组 = 未加载
//   - 渲染时 flattenTree 把展开的树压平为虚拟列表行
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@look/ui/components/ui/dropdown-menu";
import type { FileTreeNode } from "@shared/types";
import { useAtom, useSetAtom, useStore } from "jotai";
import { ChevronDown, ChevronRight, ChevronsDownUp, Eye, EyeOff, MoreHorizontal, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import {
	activeAgentIdAtom,
	chatInputInsertRequestAtom,
	expandedWorkspacePathsAtomFamily,
	loadedWorkspaceChildrenAtomFamily,
	requestViewFileAtom,
	showHiddenFilesAtom,
	workspaceTreeErrorAtomFamily,
	workspaceTreeLoadingAtomFamily,
} from "../../store/atoms";
import { FileIcon } from "./FileIcon";

interface WorkspaceTreePanelProps {
	projectId: string;
	cwd: string;
}

interface FlatRow {
	node: FileTreeNode;
	depth: number;
	parentPath: string; // 父目录相对路径,"" = 根
}

// 递归把树压平成线性行,展开的节点按 depth 缩进
function flattenTree(
	rootChildren: FileTreeNode[],
	expanded: Set<string>,
	loaded: Map<string, FileTreeNode[]>,
): FlatRow[] {
	const rows: FlatRow[] = [];

	const walk = (children: FileTreeNode[], depth: number, parentPath: string) => {
		for (const node of children) {
			rows.push({ node, depth, parentPath });
			if (node.type === "directory" && expanded.has(node.path)) {
				const grandChildren = loaded.get(node.path);
				if (grandChildren) walk(grandChildren, depth + 1, node.path);
			}
		}
	};

	walk(rootChildren, 0, "");
	return rows;
}

const INDENT_PX = 14;

/** Initialize a ref lazily so expensive values are not rebuilt on every render. */
function useLazyRef<T>(factory: () => T): React.MutableRefObject<T> {
	const ref = useRef<T | null>(null);
	if (ref.current === null) ref.current = factory();
	return ref as React.MutableRefObject<T>;
}

export function WorkspaceTreePanel({ projectId, cwd: _cwd }: WorkspaceTreePanelProps) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useAtom(expandedWorkspacePathsAtomFamily(projectId));
	const [loaded, setLoaded] = useAtom(loadedWorkspaceChildrenAtomFamily(projectId));
	const [isLoading, setIsLoading] = useAtom(workspaceTreeLoadingAtomFamily(projectId));
	const [error, setError] = useAtom(workspaceTreeErrorAtomFamily(projectId));
	const [showHiddenFiles, setShowHiddenFiles] = useAtom(showHiddenFilesAtom);

	// 根目录 children(loaded map 中 "" key 指向根 children)
	const rootChildren = useMemo(() => loaded.get("") ?? [], [loaded]);

	// 跟踪已启动的 watcher path 集合,卸载 / 切换项目时统一停止(VSCode 模式防句柄累积)。
	// 用 ref 而非 state 避免触发额外 re-render。必须在 useBootstrapRoot 之前声明。
	const watchedPathsRef = useLazyRef(() => new Set<string>());

	// 异步操作世代号:projectId 变化或卸载时递增,丢弃旧 project 的异步回调。
	const operationGenRef = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies:  intentionally re-runs on projectId change to invalidate in-flight async work
	useEffect(() => {
		operationGenRef.current += 1;
		return () => {
			operationGenRef.current += 1;
		};
	}, [projectId]);

	// 首次挂载时如未加载根,自动加载
	useBootstrapRoot(projectId, setLoaded, watchedPathsRef, setIsLoading, setError, showHiddenFiles);

	// showHiddenFiles 切换时：清空缓存、停止 watcher、重新加载根目录
	useEffect(() => {
		void showHiddenFiles; // 仅作为 effect 触发条件使用
		setExpanded(new Set());
		for (const relPath of watchedPathsRef.current) {
			window.look.stopWorkspaceWatch(projectId, relPath).catch(() => undefined);
		}
		watchedPathsRef.current.clear();
		setLoaded(new Map());
		// useBootstrapRoot 会在 showHiddenFiles 变化后自动重新执行
	}, [projectId, showHiddenFiles, setExpanded, setLoaded, watchedPathsRef]);

	useEffect(() => {
		const paths = watchedPathsRef.current;
		const currentProjectId = projectId;
		return () => {
			// 组件卸载 / projectId 变化时清理所有已启动的 watcher
			for (const relPath of paths) {
				window.look.stopWorkspaceWatch(currentProjectId, relPath).catch(() => undefined);
			}
			paths.clear();
		};
	}, [projectId, watchedPathsRef]);

	const flatRows = useMemo(() => flattenTree(rootChildren, expanded, loaded), [rootChildren, expanded, loaded]);

	// 关键:用 ref 模式稳定 toggleRow 引用,避免 itemContent 里每次渲染
	// 创建新闭包导致 WorkspaceTreeNodeRow 的 onToggle props 变化。
	const handleToggleRef = useRef<(row: FlatRow) => Promise<void>>(() => Promise.resolve());
	const toggleRow = useCallback((row: FlatRow) => handleToggleRef.current(row), []);

	const handleToggleShowHidden = useCallback(() => {
		setShowHiddenFiles((prev) => !prev);
	}, [setShowHiddenFiles]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: watchedPathsRef is a stable mutable ref, not a reactive dependency
	const handleToggle = useCallback(
		async (row: FlatRow) => {
			const { node, parentPath } = row;
			if (node.type !== "directory") return;

			if (expanded.has(node.path)) {
				// 折叠:同时停 watcher,避免无 UI 显示时仍触发 workspace:updated
				setExpanded((prev) => {
					const next = new Set(prev);
					next.delete(node.path);
					return next;
				});
				if (watchedPathsRef.current.delete(node.path)) {
					window.look.stopWorkspaceWatch(projectId, node.path).catch(() => undefined);
				}
				return;
			}

			// 展开:children 已加载直接展开;否则先 load 成功后再 add expanded,
			// 避免 "展开但无子项" 的中间态(load 失败时回滚更稳)。
			if (loaded.has(node.path)) {
				setExpanded((prev) => new Set(prev).add(node.path));
				return;
			}

			const gen = operationGenRef.current;
			try {
				// react-doctor-disable-next-line async-defer-await -- 加载后需用 generation 检查请求是否已过期
				const result = await window.look.listWorkspaceChildren(projectId, node.path, showHiddenFiles);
				if (operationGenRef.current !== gen) return;
				if (result?.success && result.nodes) {
					setError(null);
					setLoaded((prev) => {
						const next = new Map(prev);
						next.set(node.path, result.nodes ?? []);
						return next;
					});
					setExpanded((prev) => new Set(prev).add(node.path));
					// 启动该目录的 watcher(只监听直接子项)
					window.look
						.startWorkspaceWatch(projectId, node.path)
						.then(() => {
							if (operationGenRef.current === gen) watchedPathsRef.current.add(node.path);
						})
						.catch(() => undefined);
				} else if (result && !result.success) {
					toast.error(result.error ?? t("workspaceTree.loadChildFailed"));
				}
			} catch (error) {
				if (operationGenRef.current !== gen) return;
				const message = error instanceof Error ? error.message : t("workspaceTree.loadChildFailed");
				toast.error(message);
			}
			// parentPath 参数保留供后续扩展
			void parentPath;
		},
		[
			expanded,
			loaded,
			projectId,
			setError,
			setExpanded,
			setLoaded,
			showHiddenFiles,
			watchedPathsRef,
			operationGenRef,
			t,
		],
	);

	// 让稳定引用的 toggleRow 始终指向最新的 handleToggle 实现。
	handleToggleRef.current = handleToggle;

	// biome-ignore lint/correctness/useExhaustiveDependencies: watchedPathsRef is a stable mutable ref, not a reactive dependency
	const handleRefresh = useCallback(async () => {
		const gen = operationGenRef.current;
		setIsLoading(true);
		setError(null);
		try {
			// react-doctor-disable-next-line async-defer-await -- 刷新后需用 generation 检查请求是否已过期
			const result = await window.look.listWorkspaceChildren(projectId, "", showHiddenFiles);
			if (operationGenRef.current !== gen) return;
			if (result?.success && result.nodes) {
				setLoaded((prev) => {
					const next = new Map(prev);
					next.set("", result.nodes ?? []);
					return next;
				});
				setError(null);
				window.look
					.startWorkspaceWatch(projectId, "")
					.then(() => {
						if (operationGenRef.current === gen) watchedPathsRef.current.add("");
					})
					.catch((err: unknown) => {
						console.error("[WorkspaceTree] Failed to start root watcher on refresh:", err);
					});
			} else {
				const errMsg = result?.error ?? t("workspaceTree.refreshFailed");
				console.error(`[WorkspaceTree] Refresh failed: ${errMsg}`);
				setError(errMsg);
				toast.error(errMsg);
			}
		} catch (error) {
			if (operationGenRef.current !== gen) return;
			const message = error instanceof Error ? error.message : t("workspaceTree.refreshFailed");
			console.error("[WorkspaceTree] Refresh exception:", error);
			setError(message);
			toast.error(message);
		} finally {
			if (operationGenRef.current === gen) setIsLoading(false);
		}
	}, [projectId, setLoaded, setIsLoading, setError, showHiddenFiles, watchedPathsRef, operationGenRef, t]);

	const handleCollapseAll = useCallback(() => {
		setExpanded(new Set());
	}, [setExpanded]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon-xs" onClick={handleRefresh} aria-label={t("workspaceTree.refresh")}>
					<RefreshCw className="size-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={handleCollapseAll}
					aria-label={t("workspaceTree.collapseAll")}
				>
					<ChevronsDownUp className="size-3.5" />
				</Button>
				<div className="flex-1" />
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={handleToggleShowHidden}
					aria-label={t(showHiddenFiles ? "workspaceTree.hideHidden" : "workspaceTree.showHidden")}
					title={t(showHiddenFiles ? "workspaceTree.hideHidden" : "workspaceTree.showHidden")}
				>
					{showHiddenFiles ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
				</Button>
			</div>
			<div className="min-h-0 flex-1" role="tree" aria-label={t("workspaceTree.label")}>
				{isLoading ? (
					<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
						<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
						<span className="text-xs text-muted-foreground">{t("workspaceTree.loading")}</span>
					</div>
				) : error ? (
					<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
						<p className="text-xs text-destructive">{error}</p>
						<Button variant="outline" size="sm" onClick={handleRefresh}>
							{t("workspaceTree.retry")}
						</Button>
					</div>
				) : rootChildren.length === 0 ? (
					<div className="px-3 py-8 text-center text-xs text-muted-foreground">{t("workspaceTree.empty")}</div>
				) : (
					<Virtuoso
						data={flatRows}
						totalCount={flatRows.length}
						itemContent={(_, row) => (
							<WorkspaceTreeNodeRowMemo
								row={row}
								isExpanded={expanded.has(row.node.path)}
								onToggle={toggleRow}
							/>
						)}
						style={{ height: "100%" }}
					/>
				)}
			</div>
		</div>
	);
}

// 单独 hook 提取出来,避免 hooks 顺序混淆
// 用 useEffect(不是 useMemo 跑副作用):React 19 / Compiler 下 useMemo 副作用可能
// 被丢弃导致根目录永不加载。
function useBootstrapRoot(
	projectId: string,
	setLoaded: (updater: (prev: Map<string, FileTreeNode[]>) => Map<string, FileTreeNode[]>) => void,
	watchedPathsRef: React.MutableRefObject<Set<string>>,
	setIsLoading: (loading: boolean) => void,
	setError: (error: string | null) => void,
	showHiddenFiles: boolean,
) {
	useEffect(() => {
		let cancelled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		setIsLoading(true);
		setError(null);

		// 超时保护：IPC 超过 10 秒仍未返回视为超时（例如 NFS 挂载不可达）
		timeoutId = setTimeout(() => {
			if (cancelled) return;
			cancelled = true;
			setIsLoading(false);
			setError("加载超时，目录可能不可达");
			toast.error("加载工作区超时");
		}, 10_000);

		void (async () => {
			try {
				const result = await window.look.listWorkspaceChildren(projectId, "", showHiddenFiles);
				if (cancelled) return;
				clearTimeout(timeoutId);
				if (result?.success) {
					setLoaded((prev) => {
						if (prev.has("")) return prev; // 已加载,跳过
						const next = new Map(prev);
						next.set("", result.nodes ?? []);
						return next;
					});
					setError(null);
					// 启动根目录 watcher（best-effort，失败不影响树展示）
					window.look
						.startWorkspaceWatch(projectId, "")
						.then(() => {
							if (!cancelled) watchedPathsRef.current.add("");
						})
						.catch((err: unknown) => {
							console.error("[WorkspaceTree] Failed to start root watcher:", err);
						});
				} else {
					const errMsg = result?.error ?? "未知错误";
					console.error(`[WorkspaceTree] Failed to load root children: ${errMsg}`);
					setError(errMsg);
					toast.error(`加载工作区失败: ${errMsg}`);
				}
			} catch (err: unknown) {
				if (cancelled) return;
				clearTimeout(timeoutId);
				const message = err instanceof Error ? err.message : "加载工作区异常";
				console.error("[WorkspaceTree] Exception loading root children:", err);
				setError(message);
				toast.error(message);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		})();

		return () => {
			cancelled = true;
			clearTimeout(timeoutId);
		};
	}, [projectId, setLoaded, watchedPathsRef, setIsLoading, setError, showHiddenFiles]);
}

interface WorkspaceTreeNodeRowProps {
	row: FlatRow;
	isExpanded: boolean;
	// onToggle 接收 row 参数,由父组件用稳定引用 + ref 模式实现
	onToggle: (row: FlatRow) => void;
}

/**
 * 构造自定义拖拽幽灵卡片：文件图标 + 文件名。
 * 元素需在 document 中才能被 setDragImage 截图，放置于视口外，
 * 拖拽结束（dragend）后由调用方移除。
 */
function createDragImageCard(name: string, svg: SVGSVGElement | null): HTMLElement {
	const card = document.createElement("div");
	card.className =
		"pointer-events-none fixed -top-[1000px] left-0 z-[9999] flex max-w-[240px] items-center gap-2 rounded-lg border border-hairline bg-card/95 px-2.5 py-1.5 shadow-lg backdrop-blur-md";
	if (svg) {
		svg.style.width = "16px";
		svg.style.height = "16px";
		svg.style.flexShrink = "0";
		card.appendChild(svg);
	}
	const label = document.createElement("span");
	label.className = "truncate text-[12px] font-medium text-foreground";
	label.textContent = name;
	card.appendChild(label);
	return card;
}

function WorkspaceTreeNodeRowImpl({ row, isExpanded, onToggle }: WorkspaceTreeNodeRowProps) {
	const { node, depth } = row;
	const isDir = node.type === "directory";
	const setInsertRequest = useSetAtom(chatInputInsertRequestAtom);
	const requestViewFile = useSetAtom(requestViewFileAtom);
	const store = useStore();

	const handleClickToggle = () => {
		onToggle(row);
	};

	// 单击文件行 → 打开文件查看器(目录保持双击展开/折叠)
	const handleViewFile = () => {
		requestViewFile(node.absolutePath);
	};

	const handleCopyPath = () => {
		void navigator.clipboard.writeText(node.absolutePath);
		toast.success("已复制绝对路径");
	};

	const handleCopyAsReference = () => {
		void navigator.clipboard.writeText(`@${node.path}`);
		// 按需读取 activeAgentId，不订阅 atom，避免切换会话时全行重渲染
		const agentId = store.get(activeAgentIdAtom) ?? "";
		setInsertRequest({
			id: Date.now(),
			agentId,
			text: `@${node.path}`,
		});
		toast.success("已复制并插入 @ 引用");
	};

	const handleRevealInFinder = () => {
		window.look.revealInFinder(node.absolutePath);
	};

	const handleDragStart = (e: React.DragEvent) => {
		e.dataTransfer.setData("application/x-look-filepath", node.absolutePath);
		e.dataTransfer.setData("application/x-look-filerelpath", node.path);
		e.dataTransfer.effectAllowed = "copy";

		// 自定义拖拽幽灵：文件图标 + 文件名卡片，替代默认的行截图。
		// FileIcon 渲染为 span[class*=inline-flex] > svg，据此定位并克隆图标。
		const iconSvg = e.currentTarget
			.querySelector<SVGSVGElement>("span[class*='inline-flex'] svg")
			?.cloneNode(true) as SVGSVGElement | null;
		const card = createDragImageCard(node.name, iconSvg);
		document.body.appendChild(card);
		e.dataTransfer.setDragImage(card, 14, 12);
		e.currentTarget.addEventListener("dragend", () => card.remove(), { once: true });
	};

	return (
		<div
			role="treeitem"
			tabIndex={0}
			aria-expanded={isDir ? isExpanded : undefined}
			aria-level={depth + 1}
			draggable
			onDragStart={handleDragStart}
			style={{ paddingLeft: depth * INDENT_PX + 8 }}
			className="group flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
			onClick={() => {
				if (isDir) handleClickToggle();
				else handleViewFile();
			}}
		>
			{isDir ? (
				<button
					type="button"
					onClick={(e) => {
						// 行内已绑单击展开/折叠，避免按钮与行事件重复触发（双向抵消）
						e.stopPropagation();
						handleClickToggle();
					}}
					className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10"
					aria-label={isExpanded ? "折叠" : "展开"}
				>
					{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				</button>
			) : (
				<span className="size-4 shrink-0" />
			)}
			<FileIcon node={node} isExpanded={isExpanded} className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{node.name}</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-xs"
						className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						onClick={(e) => e.stopPropagation()}
						aria-label="更多操作"
					>
						<MoreHorizontal className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{!isDir && <DropdownMenuItem onClick={handleViewFile}>查看文件</DropdownMenuItem>}
					<DropdownMenuItem onClick={handleCopyPath}>复制绝对路径</DropdownMenuItem>
					<DropdownMenuItem onClick={handleCopyAsReference} className="font-medium">
						复制 @ 引用
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleRevealInFinder}>在 Finder 中打开</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

// 用 memo 包裹,onToggle 在父组件已稳定;扁平行 row 仅在路径展开状态变化时
// 才会改变 isExpanded。这能避免 Dialog 关闭引发 App 根重渲染时,无意义地
// 重新执行 WorkspaceTreeNodeRow(原本 24 次)。
const WorkspaceTreeNodeRowMemo = memo(WorkspaceTreeNodeRowImpl);
