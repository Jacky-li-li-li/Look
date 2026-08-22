// ============================================================
// SharedAreaPanel — 共享区文件列表面板
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@look/ui/components/ui/dropdown-menu";
import { Input } from "@look/ui/components/ui/input";
import type { FileTreeNode } from "@shared/types";
import { useAtom, useSetAtom } from "jotai";
import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
	Import,
	LoaderCircle,
	MoreHorizontal,
	Plus,
	RefreshCw,
	Trash2,
	UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { toast } from "sonner";
import {
	expandedSharedPathsAtomFamily,
	loadedSharedChildrenAtomFamily,
	requestViewFileAtom,
	selectedSharedPathAtomFamily,
} from "../../store/atoms";
import { FileIcon } from "./FileIcon";
import { type FlatRow, flattenTree, INDENT_PX } from "./fileTreeUtils";

// 根列表高频刷新时（watcher 推送）批量校验已展开目录的防抖窗口，与 main 侧 watcher debounce 对齐。
const CHILD_REVALIDATE_DEBOUNCE_MS = 300;
const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

interface SharedAreaPanelProps {
	projectId: string;
	files: FileTreeNode[];
	isLoading: boolean;
	error: string | null;
	onAfterChange: () => Promise<void>;
}

function isPathAtOrBelow(path: string, ancestorPath: string): boolean {
	return path === ancestorPath || path.startsWith(`${ancestorPath}/`);
}

interface FileSystemEntryLike {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	fullPath?: string;
	file(success: (file: File) => void, error?: (err: Error) => void): void;
	createReader(): { readEntries(success: (entries: FileSystemEntryLike[]) => void): void };
}

interface IpcActionResult {
	success: boolean;
	error?: string;
}

function ensureSuccess(result: IpcActionResult | null | undefined, fallback: string): void {
	if (!result?.success) throw new Error(result?.error ?? fallback);
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
	ensureSuccess(await window.look.importToShared(projectId, paths), "Import failed");
	return paths.length;
}

async function importEntriesByContent(
	projectId: string,
	entries: FileSystemEntryLike[],
	relativeDir: string,
): Promise<number> {
	let count = 0;
	await Promise.all(
		entries.map(async (entry) => {
			if (entry.isFile) {
				const file = await readEntryAsFile(entry);
				const base64 = await fileToBase64(file);
				const targetPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				ensureSuccess(
					await window.look.writeSharedContent(projectId, targetPath, base64, "base64"),
					"Import failed",
				);
				count += 1;
			} else if (entry.isDirectory) {
				const subDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				ensureSuccess(await window.look.createSharedDir(projectId, subDir), "Import failed");
				const reader = entry.createReader();
				let done = false;
				const allChildren: FileSystemEntryLike[] = [];
				// createReader 一次最多返回 100 条,需要循环到空数组
				while (!done) {
					// react-doctor-disable-next-line async-await-in-loop -- createReader 分批返回，必须顺序读取直至空数组
					const children = await readDirectoryEntries(reader);
					if (children.length > 0) allChildren.push(...children);
					else done = true;
				}
				count += await importEntriesByContent(projectId, allChildren, subDir);
			}
		}),
	);
	return count;
}

async function importFilesByContent(projectId: string, files: File[]): Promise<number> {
	await Promise.all(
		files.map(async (file) => {
			const base64 = await fileToBase64(file);
			ensureSuccess(await window.look.writeSharedContent(projectId, file.name, base64, "base64"), "Import failed");
		}),
	);
	return files.length;
}

type SharedOperation = "create" | "delete" | "refresh" | "import" | "export" | null;

export function SharedAreaPanel({ projectId, files, isLoading, error, onAfterChange }: SharedAreaPanelProps) {
	const { t } = useTranslation();
	const [selectedPath, setSelectedPath] = useAtom(selectedSharedPathAtomFamily(projectId));
	const [expanded, setExpanded] = useAtom(expandedSharedPathsAtomFamily(projectId));
	const [loadedChildren, setLoadedChildren] = useAtom(loadedSharedChildrenAtomFamily(projectId));
	const [creating, setCreating] = useState<"file" | "dir" | null>(null);
	const [newName, setNewName] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<FileTreeNode | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [operation, setOperation] = useState<SharedOperation>(null);
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
	const [focusedPath, setFocusedPath] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const treeRef = useRef<HTMLElement | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const loadedChildrenRef = useRef(loadedChildren);
	const treeGenerationRef = useRef(0);
	// 每次展开请求持有唯一 token：旧请求的 finally 只允许清理自己的 loading 状态，
	// 避免删除后同路径重建时误清新请求；projectId 切换时整体清空。
	const inflightTokensRef = useRef(new Map<string, symbol>());
	loadedChildrenRef.current = loadedChildren;

	// 切项目时组件实例被复用（RightPanel 同位置渲染），本地 loading/in-flight 必须清空，
	// 否则项目 A 未完成的展开请求会把项目 B 同名目录的按钮锁在 loading/disabled。
	useEffect(() => {
		void projectId; // 切项目时清空本地 loading/in-flight，避免旧项目请求锁住新项目同名目录。
		inflightTokensRef.current.clear();
		setLoadingPaths(new Set());
		setFocusedPath(null);
	}, [projectId]);

	// 根列表在 watcher、切 tab 或手动刷新后更新。已展开目录保留展开态，
	// 但重新读取其一层子项，避免嵌套变更长期显示旧缓存。
	// 高频刷新窗口内只发一次批量校验（防抖），避免每次 watcher 推送都触发 N 次 IPC。
	useEffect(() => {
		void files; // 根列表引用变化是重校验已加载目录的触发信号。
		const generation = treeGenerationRef.current + 1;
		treeGenerationRef.current = generation;
		let cancelled = false;

		const timer = setTimeout(() => {
			const paths = Array.from(loadedChildrenRef.current.keys());
			if (paths.length === 0) return;

			void Promise.all(
				paths.map(async (path) => {
					try {
						const result = await window.look.listSharedChildren(projectId, path);
						if (result?.success) return { path, nodes: result.nodes ?? [], gone: false };
						// ENOENT/ENOTDIR 表示目录已不存在；其他失败是临时错误，应保留缓存。
						const gone = result?.errorCode === "ENOENT" || result?.errorCode === "ENOTDIR";
						return { path, nodes: null, gone };
					} catch {
						return { path, nodes: null, gone: false };
					}
				}),
			).then((results) => {
				if (cancelled || treeGenerationRef.current !== generation) return;
				const gonePaths = results.filter((result) => result.gone).map((result) => result.path);
				const isGone = (path: string) => gonePaths.some((gonePath) => isPathAtOrBelow(path, gonePath));

				setLoadedChildren((previous) => {
					const next = new Map(previous);
					for (const path of Array.from(next.keys())) {
						if (isGone(path)) next.delete(path);
					}
					for (const result of results) {
						if (result.nodes !== null && !isGone(result.path)) next.set(result.path, result.nodes);
					}
					return next;
				});
				if (gonePaths.length > 0) {
					setExpanded((previous) => new Set(Array.from(previous).filter((path) => !isGone(path))));
					setSelectedPath((previous) => (previous && isGone(previous) ? null : previous));
				}
			});
		}, CHILD_REVALIDATE_DEBOUNCE_MS);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			if (treeGenerationRef.current === generation) treeGenerationRef.current += 1;
		};
	}, [files, projectId, setExpanded, setLoadedChildren, setSelectedPath]);

	const invalidateSubtree = (path: string) => {
		treeGenerationRef.current += 1;
		setExpanded((previous) => new Set(Array.from(previous).filter((candidate) => !isPathAtOrBelow(candidate, path))));
		setLoadedChildren((previous) => {
			const next = new Map(previous);
			for (const candidate of Array.from(next.keys())) {
				if (isPathAtOrBelow(candidate, path)) next.delete(candidate);
			}
			return next;
		});
		for (const candidate of Array.from(inflightTokensRef.current.keys())) {
			if (isPathAtOrBelow(candidate, path)) inflightTokensRef.current.delete(candidate);
		}
		setLoadingPaths(
			(previous) => new Set(Array.from(previous).filter((candidate) => !isPathAtOrBelow(candidate, path))),
		);
		setSelectedPath((previous) => (previous && isPathAtOrBelow(previous, path) ? null : previous));
	};

	const handleToggleDirectory = async (node: FileTreeNode) => {
		if (node.type !== "directory") return;
		if (expanded.has(node.path)) {
			setExpanded((previous) => {
				const next = new Set(previous);
				next.delete(node.path);
				return next;
			});
			return;
		}
		if (loadedChildren.has(node.path)) {
			setExpanded((previous) => new Set(previous).add(node.path));
			return;
		}
		if (inflightTokensRef.current.has(node.path)) return;

		const token = Symbol();
		inflightTokensRef.current.set(node.path, token);
		setLoadingPaths((previous) => new Set(previous).add(node.path));
		const generation = treeGenerationRef.current;
		try {
			const result = await window.look.listSharedChildren(projectId, node.path);
			if (treeGenerationRef.current !== generation) return;
			if (!result?.success) {
				toast.error(result?.error ?? t("sharedArea.loadChildFailed"));
				return;
			}
			setLoadedChildren((previous) => {
				const next = new Map(previous);
				next.set(node.path, result.nodes ?? []);
				return next;
			});
			setExpanded((previous) => new Set(previous).add(node.path));
		} catch (error) {
			if (treeGenerationRef.current !== generation) return;
			const message = error instanceof Error ? error.message : t("sharedArea.loadChildFailed");
			toast.error(message);
		} finally {
			// 仅清理当前 token 持有的 loading：删除/重建后的新请求 token 不受影响。
			if (inflightTokensRef.current.get(node.path) === token) {
				inflightTokensRef.current.delete(node.path);
				setLoadingPaths((previous) => {
					const next = new Set(previous);
					next.delete(node.path);
					return next;
				});
			}
		}
	};

	const flatRows = useMemo(() => flattenTree(files, expanded, loadedChildren), [files, expanded, loadedChildren]);

	// roving tabindex：焦点行变更后把 DOM 焦点移到对应行；虚拟列表未渲染时静默跳过。
	useEffect(() => {
		if (!focusedPath) return;
		const safePath = focusedPath.replace(/"/g, '\\"');
		const element = treeRef.current?.querySelector(`[data-shared-path="${safePath}"]`);
		(element as HTMLElement | null)?.focus();
	}, [focusedPath]);

	const handleMoveFocus = (currentPath: string, direction: "up" | "down" | "home" | "end") => {
		const index = flatRows.findIndex((row) => row.node.path === currentPath);
		if (index === -1) return;
		let next = index;
		if (direction === "up") next = Math.max(0, index - 1);
		else if (direction === "down") next = Math.min(flatRows.length - 1, index + 1);
		else if (direction === "home") next = 0;
		else if (direction === "end") next = flatRows.length - 1;
		if (next === index) return;
		const target = flatRows[next];
		setFocusedPath(target.node.path);
		virtuosoRef.current?.scrollToIndex({ index: next, align: "center" });
	};

	const handleCreate = async () => {
		if (operation) return;
		const trimmed = newName.trim();
		if (!trimmed) {
			setCreating(null);
			return;
		}
		if (INVALID_NAME_CHARS.test(trimmed) || trimmed === ".." || trimmed === ".") {
			toast.error(t("sharedArea.invalidName"));
			return;
		}
		if (files.some((f) => f.name === trimmed)) {
			toast.error(t("sharedArea.nameExists"));
			return;
		}
		setOperation("create");
		try {
			if (creating === "file") {
				ensureSuccess(await window.look.writeSharedFile(projectId, trimmed, ""), t("sharedArea.createFailed"));
			} else {
				ensureSuccess(await window.look.createSharedDir(projectId, trimmed), t("sharedArea.createFailed"));
			}
			await onAfterChange();
			setNewName("");
			setCreating(null);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.createFailed");
			toast.error(message);
		} finally {
			setOperation(null);
		}
	};

	const handleCancelCreate = () => {
		setCreating(null);
		setNewName("");
	};

	const handleDelete = async (node: FileTreeNode) => {
		if (operation) return;
		setOperation("delete");
		try {
			ensureSuccess(await window.look.deleteSharedItem(projectId, node.path), t("sharedArea.deleteFailed"));
			invalidateSubtree(node.path);
			await onAfterChange();
			toast.success(t("sharedArea.deleted"));
			setDeleteTarget(null);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.deleteFailed");
			toast.error(message);
		} finally {
			setOperation(null);
		}
	};

	const handleRefresh = async () => {
		if (operation) return;
		setOperation("refresh");
		try {
			await onAfterChange();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.refreshFailed");
			toast.error(message);
		} finally {
			setOperation(null);
		}
	};

	const handleImport = async () => {
		if (operation) return;
		setOperation("import");
		try {
			const result = await window.look.openFileDialog({
				title: t("sharedArea.importDialogTitle"),
				allowDirectories: true,
				allowMultiple: true,
			});
			// 取消是成功分支的业务字段（success:true + canceled）：先判真失败，
			// 再判取消——取消时直接返回不报错。
			if (!result?.success) throw new Error(result?.error ?? t("sharedArea.importFailed"));
			if (result.canceled) return;
			if (!result.paths || result.paths.length === 0) return;
			ensureSuccess(await window.look.importToShared(projectId, result.paths), t("sharedArea.importFailed"));
			await onAfterChange();
			toast.success(t("sharedArea.imported", { count: result.paths.length }));
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.importFailed");
			toast.error(message);
		} finally {
			setOperation(null);
		}
	};

	const handleExport = async (node: FileTreeNode) => {
		if (operation) return;
		setOperation("export");
		try {
			const dir = await window.look.openDirectoryDialog(t("sharedArea.exportDialogTitle"));
			// 取消是成功分支的业务字段：先判真失败，再判取消。
			if (!dir?.success) throw new Error(dir?.error ?? t("sharedArea.exportFailed"));
			if (dir.canceled) return;
			if (!dir.path) return;
			ensureSuccess(
				await window.look.exportFromShared(projectId, [node.path], dir.path),
				t("sharedArea.exportFailed"),
			);
			toast.success(t("sharedArea.exported", { path: dir.path }));
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.exportFailed");
			toast.error(message);
		} finally {
			setOperation(null);
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
		const nextTarget = e.relatedTarget;
		if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
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

	const handleDrop = async (e: React.DragEvent): Promise<void> => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		const items = e.dataTransfer.items;
		const files = e.dataTransfer.files;
		if (operation) return;

		const paths: string[] = [];
		const fallbackEntries: FileSystemEntryLike[] = [];
		const fallbackFiles: File[] = [];

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
		if (items.length === 0) {
			for (const file of Array.from(files)) {
				const filePath = window.look.getPathForFile(file);
				if (filePath) paths.push(filePath);
				else fallbackFiles.push(file);
			}
		}

		setOperation("import");
		try {
			const viaPath = await importEntriesByPath(projectId, paths);
			const viaContent = await importEntriesByContent(projectId, fallbackEntries, "");
			const viaFiles = await importFilesByContent(projectId, fallbackFiles);
			const total = viaPath + viaContent + viaFiles;
			if (total === 0) {
				toast.info(t("sharedArea.dropUnrecognized"));
				return;
			}
			await onAfterChange();
			toast.success(t("sharedArea.imported", { count: total }));
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : t("sharedArea.importFailed");
			toast.error(message);
		} finally {
			setOperation(null);
		}
	};

	const isEmpty = files.length === 0 && !creating;
	const isLoadingAndEmpty = isLoading && isEmpty;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<SharedAreaToolbar
				disabled={operation !== null}
				isRefreshing={operation === "refresh"}
				onRefresh={handleRefresh}
				onCreateFile={() => setCreating("file")}
				onCreateDir={() => setCreating("dir")}
				onImport={handleImport}
			/>

			<section
				ref={treeRef}
				role="tree"
				className={`min-h-0 flex-1 ${isDragOver ? "bg-accent/30" : ""}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				aria-label={t("sharedArea.listLabel")}
				aria-busy={operation !== null || isLoading}
			>
				{creating ? (
					<FileCreationInput
						inputRef={inputRef}
						creating={creating}
						newName={newName}
						disabled={operation === "create"}
						onNewNameChange={setNewName}
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
					/>
				) : isLoadingAndEmpty ? (
					<div className="px-3 py-8 text-center text-xs text-muted-foreground">{t("sharedArea.loading")}</div>
				) : error && isEmpty ? (
					<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
						<p className="text-xs text-destructive">{error}</p>
						<Button variant="outline" size="sm" onClick={handleRefresh}>
							{t("sharedArea.retry")}
						</Button>
					</div>
				) : isEmpty ? (
					<EmptySharedState onImport={handleImport} />
				) : (
					<Virtuoso
						ref={virtuosoRef}
						data={flatRows}
						totalCount={flatRows.length}
						itemContent={(index, row) => (
							<SharedAreaNode
								row={row}
								selected={selectedPath === row.node.path}
								focused={focusedPath === row.node.path || (focusedPath === null && index === 0)}
								isExpanded={expanded.has(row.node.path)}
								isLoadingChildren={loadingPaths.has(row.node.path)}
								onSelect={setSelectedPath}
								onToggle={handleToggleDirectory}
								onFocusMove={handleMoveFocus}
								onDelete={setDeleteTarget}
								onExport={handleExport}
							/>
						)}
						style={{ height: "100%" }}
					/>
				)}
			</section>

			<Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
				<DialogContent onEscapeKeyDown={(event) => operation === "delete" && event.preventDefault()}>
					<DialogHeader>
						<DialogTitle>{t("sharedArea.deleteTitle")}</DialogTitle>
						<DialogDescription>
							{t("sharedArea.deleteDescription", { name: deleteTarget?.name })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setDeleteTarget(null)}
							disabled={operation === "delete"}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => deleteTarget && handleDelete(deleteTarget)}
							disabled={operation === "delete"}
						>
							{operation === "delete" ? t("sharedArea.deleting") : t("common.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function SharedAreaToolbar({
	disabled,
	isRefreshing,
	onRefresh,
	onCreateFile,
	onCreateDir,
	onImport,
}: {
	disabled: boolean;
	isRefreshing: boolean;
	onRefresh: () => void;
	onCreateFile: () => void;
	onCreateDir: () => void;
	onImport: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={onRefresh}
				aria-label={t("sharedArea.refresh")}
				disabled={disabled}
			>
				<RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
			</Button>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={onCreateFile}
				aria-label={t("sharedArea.newFile")}
				disabled={disabled}
			>
				<Plus className="size-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={onCreateDir}
				aria-label={t("sharedArea.newFolder")}
				disabled={disabled}
			>
				<FolderOpen className="size-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={onImport}
				aria-label={t("sharedArea.importAction")}
				disabled={disabled}
			>
				<Import className="size-3.5" />
			</Button>
		</div>
	);
}

function FileCreationInput({
	inputRef,
	creating,
	newName,
	disabled,
	onNewNameChange,
	onKeyDown,
	onBlur,
}: {
	inputRef: React.RefObject<HTMLInputElement | null>;
	creating: "file" | "dir";
	newName: string;
	disabled: boolean;
	onNewNameChange: (value: string) => void;
	onKeyDown: (e: React.KeyboardEvent) => void;
	onBlur: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex h-6 items-center gap-1 pl-[24px] pr-2">
			<span className="size-4 shrink-0" />
			{creating === "file" ? (
				<File className="size-3.5 shrink-0 text-muted-foreground" />
			) : (
				<Folder className="size-3.5 shrink-0 text-muted-foreground" />
			)}
			<Input
				ref={inputRef}
				autoFocus
				disabled={disabled}
				value={newName}
				onChange={(e) => onNewNameChange(e.target.value)}
				onKeyDown={onKeyDown}
				onBlur={onBlur}
				placeholder={creating === "file" ? t("sharedArea.fileName") : t("sharedArea.folderName")}
				className="h-5 text-xs"
			/>
		</div>
	);
}

function EmptySharedState({ onImport }: { onImport: () => void }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
			<UploadCloud className="size-5 text-muted-foreground" />
			<p className="text-xs font-medium">{t("sharedArea.empty")}</p>
			<p className="max-w-[200px] text-[10px] text-muted-foreground">{t("sharedArea.emptyHint")}</p>
			<Button variant="line" size="sm" onClick={onImport}>
				{t("sharedArea.importFiles")}
			</Button>
		</div>
	);
}

interface SharedAreaNodeProps {
	row: FlatRow;
	selected: boolean;
	focused: boolean;
	isExpanded: boolean;
	isLoadingChildren: boolean;
	onSelect: (path: string) => void;
	onToggle: (node: FileTreeNode) => Promise<void>;
	onFocusMove: (currentPath: string, direction: "up" | "down" | "home" | "end") => void;
	onDelete: (node: FileTreeNode) => void;
	onExport: (node: FileTreeNode) => void;
}

function SharedAreaNode({
	row,
	selected,
	focused,
	isExpanded,
	isLoadingChildren,
	onSelect,
	onToggle,
	onFocusMove,
	onDelete,
	onExport,
}: SharedAreaNodeProps) {
	const { node, depth } = row;
	const { t } = useTranslation();
	const requestViewFile = useSetAtom(requestViewFileAtom);
	const isDirectory = node.type === "directory";

	const handleSelect = () => {
		onSelect(node.path);
		if (isDirectory) {
			void onToggle(node);
			return;
		}
		requestViewFile(node.absolutePath);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			handleSelect();
			return;
		}
		if (event.key === "ArrowRight" && isDirectory && !isExpanded) {
			event.preventDefault();
			onSelect(node.path);
			void onToggle(node);
			return;
		}
		if (event.key === "ArrowLeft" && isDirectory && isExpanded) {
			event.preventDefault();
			onSelect(node.path);
			void onToggle(node);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			onFocusMove(node.path, "up");
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			onFocusMove(node.path, "down");
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			onFocusMove(node.path, "home");
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			onFocusMove(node.path, "end");
		}
	};

	const revealInFinder = async () => {
		const result = await window.look.revealInFinder(node.absolutePath);
		if (!result?.success) toast.error(result?.error ?? t("sharedArea.revealFailed"));
	};

	const copyAbsolutePath = async () => {
		try {
			await navigator.clipboard.writeText(node.absolutePath);
			toast.success(t("sharedArea.pathCopied"));
		} catch {
			toast.error(t("sharedArea.copyFailed"));
		}
	};

	return (
		<div
			role="treeitem"
			tabIndex={focused ? 0 : -1}
			data-shared-path={node.path}
			aria-label={t(isDirectory ? "sharedArea.folderLabel" : "sharedArea.fileLabel", { name: node.name })}
			aria-level={depth + 1}
			aria-selected={selected}
			aria-expanded={isDirectory ? isExpanded : undefined}
			aria-busy={isLoadingChildren || undefined}
			style={{ paddingLeft: depth * INDENT_PX + 8 }}
			className={`group flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${
				selected ? "bg-accent text-accent-foreground" : "text-foreground"
			}`}
			onClick={handleSelect}
			onKeyDown={handleKeyDown}
			onDoubleClick={() => !isDirectory && void revealInFinder()}
		>
			{isDirectory ? (
				<button
					type="button"
					tabIndex={-1}
					disabled={isLoadingChildren}
					onClick={(event) => {
						event.stopPropagation();
						void onToggle(node);
					}}
					className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 disabled:cursor-wait"
					aria-label={t(isExpanded ? "sharedArea.collapseFolder" : "sharedArea.expandFolder", {
						name: node.name,
					})}
				>
					{isLoadingChildren ? (
						<LoaderCircle className="size-3 animate-spin" />
					) : isExpanded ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronRight className="size-3" />
					)}
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
						className="size-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						onClick={(e) => e.stopPropagation()}
						aria-label={t("sharedArea.moreActions")}
					>
						<MoreHorizontal className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => void copyAbsolutePath()}>{t("sharedArea.copyPath")}</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void revealInFinder()}>
						{t("sharedArea.revealInFinder")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => onExport(node)}>{t("sharedArea.exportAction")}</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => onDelete(node)}>
						<Trash2 className="size-4" /> {t("common.delete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
