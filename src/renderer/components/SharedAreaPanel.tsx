// ============================================================
// SharedAreaPanel — 共享区文件列表面板
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@shared/components/ui/dropdown-menu";
import { Input } from "@shared/components/ui/input";
import type { FileTreeNode } from "@shared/types";
import { useAtom } from "jotai";
import { File, Folder, FolderOpen, Import, MoreHorizontal, Plus, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { selectedSharedPathAtomFamily } from "../store/atoms";

interface SharedAreaPanelProps {
	projectId: string;
	files: FileTreeNode[];
	isLoading: boolean;
	onAfterChange: () => Promise<void>;
}

const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

export function SharedAreaPanel({ projectId, files, isLoading, onAfterChange }: SharedAreaPanelProps) {
	const [selectedPath, setSelectedPath] = useAtom(selectedSharedPathAtomFamily(projectId));
	const [creating, setCreating] = useState<"file" | "dir" | null>(null);
	const [newName, setNewName] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<FileTreeNode | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleCreate = async () => {
		const trimmed = newName.trim();
		if (!trimmed) {
			setCreating(null);
			return;
		}
		if (INVALID_NAME_CHARS.test(trimmed) || trimmed === ".." || trimmed === ".") {
			toast.error("文件名包含非法字符");
			return;
		}
		if (files.some((f) => f.name === trimmed)) {
			toast.error("文件名已存在");
			return;
		}
		try {
			if (creating === "file") {
				await window.look.writeSharedFile(projectId, trimmed, "");
			} else {
				await window.look.createSharedDir(projectId, trimmed);
			}
			await onAfterChange();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "创建失败";
			toast.error(message);
		}
		setNewName("");
		setCreating(null);
	};

	const handleCancelCreate = () => {
		setCreating(null);
		setNewName("");
	};

	const handleDelete = async (node: FileTreeNode) => {
		try {
			await window.look.deleteSharedItem(projectId, node.path);
			if (selectedPath === node.path) setSelectedPath(null);
			await onAfterChange();
			toast.success("已删除");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "删除失败";
			toast.error(message);
		}
		setDeleteTarget(null);
	};

	const handleRefresh = async () => {
		try {
			await onAfterChange();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "刷新共享区失败";
			toast.error(message);
		}
	};

	const handleImport = async () => {
		try {
			const result = await window.look.openFileDialog({
				title: "选择要导入的文件或文件夹",
				allowDirectories: true,
				allowMultiple: true,
			});
			if (!result?.success || !result.paths || result.paths.length === 0) return;
			await window.look.importToShared(projectId, result.paths);
			await onAfterChange();
			toast.success(`已导入 ${result.paths.length} 项`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "导入失败";
			toast.error(message);
		}
	};

	const handleExport = async (node: FileTreeNode) => {
		try {
			const dir = await window.look.openDirectoryDialog("选择导出位置");
			if (!dir?.success || !dir.path) return;
			await window.look.exportFromShared(projectId, [node.path], dir.path);
			toast.success(`已导出到 ${dir.path}`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "导出失败";
			toast.error(message);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	};

	// ============================================================
	// Drag-drop 处理(VSCode 启发 + Proma 优化)
	//
	// 关键技术:dataTransfer.items[i].webkitGetAsEntry()
	//   - items 含 file/directory 两种条目,绕过 dataTransfer.files 无法取目录的局限
	//   - 对文件: 优先用 webUtils.getPathForFile() 拿绝对路径(主端 cp,高效)
	//            失败时回退到读 File 内容 + base64 上传(慢但可靠)
	//   - 对目录: 优先用 path(主端 cp recursive)
	//            失败时用 createReader().readEntries() 递归读内容上传
	// ============================================================

	interface FileSystemEntryLike {
		name: string;
		isFile: boolean;
		isDirectory: boolean;
		fullPath?: string;
		file(success: (file: File) => void, error?: (err: Error) => void): void;
		createReader(): { readEntries(success: (entries: FileSystemEntryLike[]) => void): void };
	}

	function readEntryAsFile(entry: FileSystemEntryLike): Promise<File> {
		return new Promise((resolve, reject) => {
			try {
				entry.file(resolve, reject);
			} catch (error) {
				reject(error instanceof Error ? error : new Error("readEntryAsFile failed"));
			}
		});
	}

	function readDirectoryEntries(reader: {
		readEntries(success: (entries: FileSystemEntryLike[]) => void): void;
	}): Promise<FileSystemEntryLike[]> {
		return new Promise((resolve, reject) => {
			try {
				reader.readEntries(resolve);
			} catch (error) {
				reject(error instanceof Error ? error : new Error("readDirectoryEntries failed"));
			}
		});
	}

	async function fileToBase64(file: File): Promise<string> {
		const buffer = await file.arrayBuffer();
		let binary = "";
		const bytes = new Uint8Array(buffer);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
		}
		return btoa(binary);
	}

	async function importEntriesByPath(projectId: string, paths: string[]): Promise<number> {
		if (paths.length === 0) return 0;
		await window.look.importToShared(projectId, paths);
		return paths.length;
	}

	async function importEntriesByContent(
		projectId: string,
		entries: FileSystemEntryLike[],
		relativeDir: string,
		depth = 0,
	): Promise<number> {
		const MAX_DEPTH = 50;
		if (depth > MAX_DEPTH) {
			toast.warning(`目录嵌套过深(${MAX_DEPTH}层),已跳过深层内容`);
			return 0;
		}
		let count = 0;
		for (const entry of entries) {
			if (entry.isFile) {
				const file = await readEntryAsFile(entry);
				const base64 = await fileToBase64(file);
				const targetPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				await window.look.writeSharedContent(projectId, targetPath, base64, "base64");
				count += 1;
			} else if (entry.isDirectory) {
				const subDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				await window.look.createSharedDir(projectId, subDir);
				const reader = entry.createReader();
				let done = false;
				const allChildren: FileSystemEntryLike[] = [];
				// createReader 一次最多返回 100 条,需要循环到空数组
				while (!done) {
					const children = await readDirectoryEntries(reader);
					if (children.length > 0) allChildren.push(...children);
					else done = true;
				}
				count += await importEntriesByContent(projectId, allChildren, subDir, depth + 1);
			}
		}
		return count;
	}

	const handleDrop = async (e: React.DragEvent): Promise<void> => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		const items = e.dataTransfer.items;
		const files = e.dataTransfer.files;
		if (items.length === 0) {
			toast.info("无法识别拖入内容,请使用「导入」按钮");
			return;
		}

		const paths: string[] = [];
		const fallbackEntries: FileSystemEntryLike[] = [];

		// 关键:用 items[i].webkitGetAsEntry() 而非 dataTransfer.files,前者能识别目录
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			if (item.kind !== "file") continue;
			const entry = item.webkitGetAsEntry() as FileSystemEntryLike | null;
			if (!entry) continue;

			// 对应位置的 File 对象(文件夹的 File 是 size=0 的空壳,Electron 可用)
			const file = i < files.length ? files[i] : null;
			const filePath = file ? window.look.getPathForFile(file) : null;
			if (filePath) {
				paths.push(filePath);
			} else {
				// 拿不到绝对路径(Electron 旧版 / 沙箱限制)→ fallback 到内容上传
				fallbackEntries.push(entry);
			}
		}

		try {
			const viaPath = await importEntriesByPath(projectId, paths);
			const viaContent = await importEntriesByContent(projectId, fallbackEntries, "");
			const total = viaPath + viaContent;
			if (total === 0) {
				toast.info("无法识别拖入内容,请使用「导入」按钮");
				return;
			}
			await onAfterChange();
			const detail = viaContent > 0 ? ` (${viaPath} 个用绝对路径, ${viaContent} 个用内容上传)` : "";
			toast.success(`已导入 ${total} 项${detail}`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "导入失败";
			toast.error(message);
		}
	};

	const isEmpty = files.length === 0 && !creating;
	const isLoadingAndEmpty = isLoading && isEmpty;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon-xs" onClick={handleRefresh} aria-label="刷新">
					<RefreshCw className="size-3.5" />
				</Button>
				<Button variant="ghost" size="icon-xs" onClick={() => setCreating("file")} aria-label="新建文件">
					<Plus className="size-3.5" />
				</Button>
				<Button variant="ghost" size="icon-xs" onClick={() => setCreating("dir")} aria-label="新建文件夹">
					<FolderOpen className="size-3.5" />
				</Button>
				<Button variant="ghost" size="icon-xs" onClick={handleImport} aria-label="导入文件或文件夹">
					<Import className="size-3.5" />
				</Button>
			</div>

			<div
				className={`min-h-0 flex-1 ${isDragOver ? "bg-accent/30" : ""}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				role="region"
				aria-label="共享区文件列表，可拖入文件导入"
			>
				{creating ? (
					<div className="flex items-center gap-2 px-2 py-1">
						{creating === "file" ? (
							<File className="size-4 text-muted-foreground" />
						) : (
							<Folder className="size-4 text-muted-foreground" />
						)}
						<Input
							ref={inputRef}
							autoFocus
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleCreate();
								}
								if (e.key === "Escape") {
									e.preventDefault();
									handleCancelCreate();
								}
							}}
							onBlur={() => {
								requestAnimationFrame(() => {
									if (document.activeElement !== inputRef.current) {
										handleCreate();
									}
								});
							}}
							placeholder={creating === "file" ? "文件名" : "文件夹名"}
							className="h-6 text-xs"
						/>
					</div>
				) : isLoadingAndEmpty ? (
					<div className="px-3 py-8 text-center text-xs text-muted-foreground">加载中…</div>
				) : isEmpty ? (
					<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
						<UploadCloud className="size-5 text-muted-foreground" />
						<p className="text-xs font-medium">共享区为空</p>
						<p className="max-w-[200px] text-[10px] text-muted-foreground">
							创建文件、点击导入，或将文件拖入此处
						</p>
						<Button variant="line" size="sm" onClick={handleImport}>
							导入文件
						</Button>
					</div>
				) : (
					<Virtuoso
						data={files}
						totalCount={files.length}
						itemContent={(index) => {
							const node = files[index];
							return (
								<SharedAreaNode
									node={node}
									selected={selectedPath === node.path}
									onSelect={setSelectedPath}
									onDelete={setDeleteTarget}
									onExport={handleExport}
								/>
							);
						}}
						style={{ height: "100%" }}
					/>
				)}
			</div>

			<Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>确认删除</DialogTitle>
						<DialogDescription>确定要删除 “{deleteTarget?.name}” 吗？此操作不可撤销。</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
							取消
						</Button>
						<Button variant="destructive" size="sm" onClick={() => deleteTarget && handleDelete(deleteTarget)}>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

interface SharedAreaNodeProps {
	node: FileTreeNode;
	selected: boolean;
	onSelect: (path: string) => void;
	onDelete: (node: FileTreeNode) => void;
	onExport: (node: FileTreeNode) => void;
}

function SharedAreaNode({ node, selected, onSelect, onDelete, onExport }: SharedAreaNodeProps) {
	const Icon = node.type === "directory" ? Folder : File;
	return (
		<div
			role="button"
			tabIndex={0}
			aria-selected={selected}
			aria-label={node.type === "directory" ? `文件夹: ${node.name}` : `文件: ${node.name}`}
			className={`group flex h-7 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
				selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted"
			}`}
			onClick={() => onSelect(node.path)}
			onDoubleClick={() => {
				if (node.type === "file") {
					window.look.revealInFinder(node.absolutePath);
				}
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect(node.path);
				}
			}}
		>
			<div className="flex min-w-0 items-center gap-2">
				<Icon className="size-4 shrink-0 text-muted-foreground" />
				<span className="truncate">{node.name}</span>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-xs"
						className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						onClick={(e) => e.stopPropagation()}
						aria-label="更多操作"
					>
						<MoreHorizontal className="size-3.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => window.look.revealInFinder(node.absolutePath)}>
						在 Finder 中打开
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => onExport(node)}>导出到…</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => onDelete(node)}>
						<Trash2 className="size-4" /> 删除
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
