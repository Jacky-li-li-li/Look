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

import { Button } from "@shared/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import type { FileTreeNode } from "@shared/types";
import { useAtom } from "jotai";
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	File,
	Folder,
	FolderOpen,
	MoreHorizontal,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { expandedWorkspacePathsAtomFamily, loadedWorkspaceChildrenAtomFamily } from "../store/atoms";

interface WorkspaceTreePanelProps {
	projectId: string;
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

export function WorkspaceTreePanel({ projectId }: WorkspaceTreePanelProps) {
	const [expanded, setExpanded] = useAtom(expandedWorkspacePathsAtomFamily(projectId));
	const [loaded, setLoaded] = useAtom(loadedWorkspaceChildrenAtomFamily(projectId));

	// 根目录 children(loaded map 中 "" key 指向根 children)
	const rootChildren = loaded.get("") ?? [];

	// 首次挂载时如未加载根,自动加载
	useAtomBootstrapRoot(projectId, setLoaded);

	const flatRows = useMemo(() => flattenTree(rootChildren, expanded, loaded), [rootChildren, expanded, loaded]);

	const handleToggle = useCallback(
		async (row: FlatRow) => {
			const { node, parentPath } = row;
			if (node.type !== "directory") return;

			if (expanded.has(node.path)) {
				// 折叠
				setExpanded((prev) => {
					const next = new Set(prev);
					next.delete(node.path);
					return next;
				});
				return;
			}

			// 展开:确保 children 已加载,若未加载则拉取
			setExpanded((prev) => new Set(prev).add(node.path));
			if (!loaded.has(node.path)) {
				try {
					const result = await window.look.listWorkspaceChildren(projectId, node.path);
					if (result?.success && result.nodes) {
						setLoaded((prev) => {
							const next = new Map(prev);
							next.set(node.path, result.nodes ?? []);
							return next;
						});
						// 启动该目录的 watcher(只监听直接子项)
						window.look.startWorkspaceWatch(projectId, node.path).catch(() => undefined);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : "加载子目录失败";
					toast.error(message);
					setExpanded((prev) => {
						const next = new Set(prev);
						next.delete(node.path);
						return next;
					});
				}
			}
			},
		[expanded, loaded, projectId, setExpanded, setLoaded],
	);

	const handleRefresh = useCallback(async () => {
		try {
			const result = await window.look.listWorkspaceChildren(projectId, "");
			if (result?.success && result.nodes) {
				setLoaded((prev) => {
					const next = new Map(prev);
					next.set("", result.nodes ?? []);
					return next;
				});
				window.look.startWorkspaceWatch(projectId, "").catch(() => undefined);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "刷新失败";
			toast.error(message);
		}
	}, [projectId, setLoaded]);

	const handleCollapseAll = useCallback(() => {
		setExpanded(new Set());
	}, [setExpanded]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon-xs" onClick={handleRefresh} aria-label="刷新">
					<RefreshCw className="size-3.5" />
				</Button>
				<Button variant="ghost" size="icon-xs" onClick={handleCollapseAll} aria-label="折叠全部">
					<ChevronsDownUp className="size-3.5" />
				</Button>
			</div>
			<div className="min-h-0 flex-1" role="tree" aria-label="工作区文件树">
				{rootChildren.length === 0 ? (
					<div className="px-3 py-8 text-center text-xs text-muted-foreground">加载中…</div>
				) : (
					<Virtuoso
						data={flatRows}
						totalCount={flatRows.length}
						itemContent={(_, row) => (
							<WorkspaceTreeNodeRow
								row={row}
								isExpanded={expanded.has(row.node.path)}
								onToggle={() => handleToggle(row)}
							/>
						)}
						style={{ height: "100%" }}
					/>
				)}
			</div>
		</div>
	);
}

// 首次挂载时如未加载根,自动拉取
function useAtomBootstrapRoot(
	projectId: string,
	setLoaded: (updater: (prev: Map<string, FileTreeNode[]>) => Map<string, FileTreeNode[]>) => void,
) {
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.look.listWorkspaceChildren(projectId, "");
				if (cancelled) return;
				if (result?.success && result.nodes) {
					setLoaded((prev) => {
						if (prev.has("")) return prev; // 已加载,跳过
						const next = new Map(prev);
						next.set("", result.nodes ?? []);
						return next;
					});
					window.look.startWorkspaceWatch(projectId, "").catch(() => undefined);
				}
			} catch {
				// best-effort:用户切到空项目时静默
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId, setLoaded]);
}

interface WorkspaceTreeNodeRowProps {
	row: FlatRow;
	isExpanded: boolean;
	onToggle: () => void;
}

function WorkspaceTreeNodeRow({ row, isExpanded, onToggle }: WorkspaceTreeNodeRowProps) {
	const { node, depth } = row;
	const isDir = node.type === "directory";
	const Icon = isDir ? (isExpanded ? FolderOpen : Folder) : File;

	const handleCopyPath = () => {
		void navigator.clipboard.writeText(node.absolutePath);
		toast.success("已复制绝对路径");
	};

	const handleCopyAsReference = () => {
		void navigator.clipboard.writeText(`@${node.path}`);
		toast.success("已复制 @ 引用");
	};

	const handleOpenInAgent = () => {
		// 简化方案:向当前活跃 agent 发送 @filename,让 agent 自己读文件
		// 实际实现需要 activeAgentId,在父组件传入或通过 atom 读取
		void navigator.clipboard.writeText(`@${node.path}`);
		toast.info("已复制 @ 引用,粘贴到聊天框发送给 agent");
	};

	const handleDragStart = (e: React.DragEvent) => {
		e.dataTransfer.setData("application/x-look-filepath", node.absolutePath);
		e.dataTransfer.setData("application/x-look-filerelpath", node.path);
		e.dataTransfer.effectAllowed = "copy";
	};

	return (
		<div
			role="treeitem"
			aria-expanded={isDir ? isExpanded : undefined}
			aria-level={depth + 1}
			draggable
			onDragStart={handleDragStart}
			style={{ paddingLeft: depth * INDENT_PX + 8 }}
			className="group flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
			onDoubleClick={() => {
				if (isDir) onToggle();
				else handleOpenInAgent();
			}}
		>
			{isDir ? (
				<button
					type="button"
					onClick={onToggle}
					className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10"
					aria-label={isExpanded ? "折叠" : "展开"}
				>
					{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				</button>
			) : (
				<span className="size-4 shrink-0" />
			)}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
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
					{!isDir && <DropdownMenuItem onClick={handleOpenInAgent}>在 agent 中打开</DropdownMenuItem>}
					<DropdownMenuItem onClick={handleCopyPath}>复制绝对路径</DropdownMenuItem>
					<DropdownMenuItem onClick={handleCopyAsReference}>复制 @ 引用</DropdownMenuItem>
					<DropdownMenuItem onClick={() => window.look.revealInFinder(node.absolutePath)}>
						在 Finder 中打开
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
