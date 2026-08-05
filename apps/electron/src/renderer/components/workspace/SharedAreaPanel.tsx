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
import { File, Folder, FolderOpen, Import, MoreHorizontal, Plus, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { requestViewFileAtom, selectedSharedPathAtomFamily } from "../../store/atoms";
import { FileIcon } from "./FileIcon";

interface SharedAreaPanelProps {
	projectId: string;
	files: FileTreeNode[];
	isLoading: boolean;
	onAfterChange: () => Promise<void>;
}

const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

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

export function SharedAreaPanel({ projectId, files, isLoading, onAfterChange }: SharedAreaPanelProps) {
	const { t } = useTranslation();
	const [selectedPath, setSelectedPath] = useAtom(selectedSharedPathAtomFamily(projectId));
	const [creating, setCreating] = useState<"file" | "dir" | null>(null);
	const [newName, setNewName] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<FileTreeNode | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [operation, setOperation] = useState<SharedOperation>(null);
	const inputRef = useRef<HTMLInputElement>(null);

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
			if (selectedPath === node.path) setSelectedPath(null);
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
				) : isEmpty ? (
					<EmptySharedState onImport={handleImport} />
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
	node: FileTreeNode;
	selected: boolean;
	onSelect: (path: string) => void;
	onDelete: (node: FileTreeNode) => void;
	onExport: (node: FileTreeNode) => void;
}

function SharedAreaNode({ node, selected, onSelect, onDelete, onExport }: SharedAreaNodeProps) {
	const { t } = useTranslation();
	const requestViewFile = useSetAtom(requestViewFileAtom);

	const handleSelect = () => {
		onSelect(node.path);
		if (node.type === "file") requestViewFile(node.absolutePath);
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
			tabIndex={0}
			aria-label={t(node.type === "directory" ? "sharedArea.folderLabel" : "sharedArea.fileLabel", {
				name: node.name,
			})}
			className={`group flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${
				selected ? "bg-accent text-accent-foreground" : "text-foreground"
			}`}
			onClick={handleSelect}
			onDoubleClick={() => node.type === "file" && void revealInFinder()}
		>
			<span className="size-4 shrink-0" />
			<FileIcon node={node} className="size-3.5 shrink-0" />
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
