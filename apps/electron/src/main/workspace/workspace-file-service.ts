// ============================================================
// WorkspaceFileService — 项目共享区与工作区文件管理
//
// 职责：
//   - 管理 ~/.look/shared/<project-id>/ 的 CRUD
//   - 使用 chokidar 监听共享区目录变更，通过 IPC 推送到渲染进程
//   - 所有路径操作均做路径穿越校验
// ============================================================

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureProjectSharedDir, getProjectSharedDir } from "@look/shared/look-storage";
import type { FileTreeNode, MainToRendererEvent } from "@look/shared/types";
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { resolveInsideRoot } from "./path-guard.js";

export type WorkspaceFileServiceEventCallback = (event: MainToRendererEvent) => void;

const WATCHER_DEBOUNCE_MS = 300;

// 共享区单文件最大字节数(防御 OOM:渲染端可通过 shared:write 提交任意大小字符串)。
// 50 MB 与 drag-drop fallback (writeSharedContent) 对齐,统一上限。
export const SHARED_MAX_CONTENT_BYTES = 50 * 1024 * 1024;

export class WorkspaceFileService {
	private readonly watchers = new Map<string, FSWatcher>();
	/** ready 前的 watcher 登记，供 stopWatching 提前取消，避免句柄泄漏。 */
	private readonly pendingWatchers = new Map<string, { watcher: FSWatcher; aborted: boolean }>();
	private readonly pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
	private emitCallback: WorkspaceFileServiceEventCallback | null = null;

	setEmitCallback(callback: WorkspaceFileServiceEventCallback): void {
		this.emitCallback = callback;
	}

	/**
	 * 清空 emit 回调。registerIpcHandlers 在 macOS activate 重建窗口时
	 * 会重新 set;旧 callback 通过此方法显式解绑,避免累积(M-7)。
	 */
	clearEmitCallback(): void {
		this.emitCallback = null;
	}

	private emit(event: MainToRendererEvent): void {
		this.emitCallback?.(event);
	}

	// ── Path helpers ──

	private async resolveSharedPath(projectId: string, relativePath: string): Promise<string> {
		if (typeof relativePath !== "string" || relativePath.length === 0) {
			throw new Error("Invalid path: empty");
		}
		const root = ensureProjectSharedDir(projectId);
		await this.assertSharedRootNotSymlink(root);
		return resolveInsideRoot({ root, rootName: "shared area", relativePath });
	}

	/** 共享区根目录自身不允许是 symlink：resolveInsideRoot 假定 root 可信，
	 *  若 shared/<projectId> 指向外部，realpath(root) 会把外部目录当作新 root。 */
	private async assertSharedRootNotSymlink(root: string): Promise<void> {
		const stat = await this.statSafe(root);
		if (stat?.isSymbolicLink()) {
			throw new Error("Shared area root must not be a symbolic link");
		}
	}

	private async statSafe(targetPath: string): Promise<fs.Stats | null> {
		try {
			return await fs.promises.lstat(targetPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
			throw error;
		}
	}

	private async readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
		return fs.promises.readdir(dirPath, { withFileTypes: true });
	}

	private async buildNode(entry: fs.Dirent, parentPath: string, root: string): Promise<FileTreeNode> {
		const absolutePath = path.join(parentPath, entry.name);
		const relativePath = path.relative(root, absolutePath);
		const isDirectory = entry.isDirectory();
		const node: FileTreeNode = {
			name: entry.name,
			path: relativePath.replace(/\\/g, "/"),
			absolutePath,
			type: isDirectory ? "directory" : "file",
			children: isDirectory ? [] : undefined,
			extension: isDirectory ? undefined : path.extname(entry.name).slice(1) || undefined,
			isSymlink: entry.isSymbolicLink(),
			isHidden: entry.name.startsWith("."),
		};
		if (!isDirectory) {
			try {
				const stat = await fs.promises.lstat(absolutePath);
				node.size = stat.size;
				node.modifiedAt = stat.mtimeMs;
			} catch {
				// 忽略无法获取元数据的文件
			}
		}
		return node;
	}

	// ── Shared area CRUD ──

	async listSharedFiles(projectId: string): Promise<FileTreeNode[]> {
		return this.listSharedDirectory(projectId, "");
	}

	/** 列出共享区内已存在目录的一层子项；空路径只由根目录 list API 使用。 */
	async listSharedChildren(projectId: string, relativePath: string): Promise<FileTreeNode[]> {
		if (typeof relativePath !== "string" || relativePath.length === 0) {
			throw new Error("Invalid path: empty");
		}
		return this.listSharedDirectory(projectId, relativePath);
	}

	private async listSharedDirectory(projectId: string, relativePath: string): Promise<FileTreeNode[]> {
		const root = ensureProjectSharedDir(projectId);
		await this.assertSharedRootNotSymlink(root);
		const target = relativePath === "" ? root : await this.resolveSharedPath(projectId, relativePath);
		const stat = await this.statSafe(target);
		if (!stat?.isDirectory()) {
			const error = new Error("Shared path must be an existing directory") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		const entries = await this.readDirEntries(target);
		const nodes = await Promise.all(entries.map((entry) => this.buildNode(entry, target, root)));
		nodes.sort((a, b) => {
			if (a.type === b.type) return a.name.localeCompare(b.name);
			return a.type === "directory" ? -1 : 1;
		});
		return nodes;
	}

	async writeSharedFile(projectId: string, relativePath: string, content: string | Buffer): Promise<void> {
		// 字符串内容在 IPC 入口就可能被分配到 V8 堆,提前 size check 防止 OOM。
		// Buffer 路径(由 writeSharedContent / drag-drop 内部调用)已在调用方检查过。
		if (typeof content === "string" && Buffer.byteLength(content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
			throw new Error(`Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)`);
		}
		const target = await this.resolveSharedPath(projectId, relativePath);
		const parent = path.dirname(target);
		await fs.promises.mkdir(parent, { recursive: true });
		// randomBytes 8 字节足够防并发同名 tmp 冲突(不暴露 pid)。
		const tempPath = `${target}.tmp.${crypto.randomBytes(8).toString("hex")}`;
		try {
			await fs.promises.writeFile(tempPath, content);
			await fs.promises.rename(tempPath, target);
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async writeSharedContent(
		projectId: string,
		relativePath: string,
		content: string,
		encoding: "base64" | "utf8" = "utf8",
	): Promise<void> {
		const charLimit = SHARED_MAX_CONTENT_BYTES * 4;
		if (content.length > charLimit) {
			throw new Error(`Content too large: ${content.length} chars (max ${charLimit})`);
		}
		const buffer = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
		if (buffer.byteLength > SHARED_MAX_CONTENT_BYTES) {
			throw new Error(`Content too large: ${buffer.byteLength} bytes (max ${SHARED_MAX_CONTENT_BYTES} bytes)`);
		}
		await this.writeSharedFile(projectId, relativePath, buffer);
	}

	async createSharedDir(projectId: string, relativePath: string): Promise<void> {
		const target = await this.resolveSharedPath(projectId, relativePath);
		await fs.promises.mkdir(target, { recursive: true });
	}

	async deleteSharedItem(projectId: string, relativePath: string): Promise<void> {
		const target = await this.resolveSharedPath(projectId, relativePath);
		const stat = await this.statSafe(target);
		if (!stat) return;
		if (stat.isDirectory()) {
			await fs.promises.rm(target, { recursive: true, force: true });
		} else {
			await fs.promises.unlink(target);
		}
	}

	async importToShared(projectId: string, sources: string[], targetDir = ""): Promise<void> {
		ensureProjectSharedDir(projectId);
		const destRoot =
			targetDir.length === 0 ? getProjectSharedDir(projectId) : await this.resolveSharedPath(projectId, targetDir);
		const destStat = await this.statSafe(destRoot);
		if (!destStat?.isDirectory()) {
			throw new Error("Import destination must be an existing directory");
		}
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		if (!homeDir) {
			throw new Error("Cannot determine user home directory for import");
		}
		const imported: string[] = [];
		const outcomes = await Promise.allSettled(
			sources.map(async (source) => {
				const resolved = path.isAbsolute(source) ? path.resolve(source) : path.resolve(homeDir, source);
				const prefix = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
				if (resolved !== homeDir && !resolved.startsWith(prefix)) {
					throw new Error(`Import source must be within the user home directory: ${source}`);
				}
				const srcStat = await this.statSafe(resolved);
				if (!srcStat) return null;
				const dest = path.join(destRoot, path.basename(resolved));
				const destExists = await this.statSafe(dest);
				if (destExists) {
					throw new Error(`Import target already exists: ${path.basename(resolved)}`);
				}
				if (srcStat.isDirectory()) {
					await fs.promises.cp(resolved, dest, { recursive: true, errorOnExist: true });
				} else {
					await fs.promises.cp(resolved, dest, { errorOnExist: true });
				}
				return dest;
			}),
		);
		// 先收集所有成功复制项再判断失败，否则部分成功后抛错时 imported 仍为空，
		// 已复制的半成品不会被回滚清理。
		for (const outcome of outcomes) {
			if (outcome.status === "fulfilled" && outcome.value) imported.push(outcome.value);
		}
		const firstRejection = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
		if (firstRejection) {
			await Promise.all(
				imported.map((item) => fs.promises.rm(item, { recursive: true, force: true }).catch(() => undefined)),
			);
			throw firstRejection.reason;
		}
	}

	async exportFromShared(projectId: string, relativePaths: string[], destDir: string): Promise<void> {
		const resolvedDest = path.resolve(destDir);
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		if (!homeDir || homeDir === "/" || resolvedDest === "/") {
			throw new Error("Export destination too broad");
		}
		if (resolvedDest !== homeDir && !resolvedDest.startsWith(homeDir + path.sep)) {
			throw new Error("Export destination must be within the user home directory");
		}
		// 敏感区拦截：dotfile/LOOK_HOME/~/Library 关键目录一律不可作为导出目标
		// （内容由渲染端经 shared:write 控制，写入 ~/.zshrc、LaunchAgents 等
		// 等于把渲染端可控内容落盘到持久化/提权位置）。
		if (isSensitivePath(resolvedDest)) {
			throw new Error("Export destination is a sensitive location");
		}
		// 词法校验后仍要防止 home 内的 symlink 指向 home 外：mkdir 后再 realpath
		// 校验一次，阻止数据写到 home 之外或落入敏感区。
		const resolvedHome = await fs.promises.realpath(homeDir).catch(() => homeDir);
		await fs.promises.mkdir(resolvedDest, { recursive: true });
		const realDest = await fs.promises.realpath(resolvedDest);
		const homePrefix = resolvedHome.endsWith(path.sep) ? resolvedHome : `${resolvedHome}${path.sep}`;
		if (realDest !== resolvedHome && !realDest.startsWith(homePrefix)) {
			throw new Error("Export destination resolves outside the user home directory");
		}
		if (isSensitivePath(realDest)) {
			throw new Error("Export destination resolves to a sensitive location");
		}
		await Promise.all(
			relativePaths.map(async (relativePath) => {
				const source = await this.resolveSharedPath(projectId, relativePath);
				const stat = await this.statSafe(source);
				if (!stat) return;
				const dest = path.join(resolvedDest, path.basename(source));
				const destExists = await this.statSafe(dest);
				if (destExists) {
					throw new Error(`Export target already exists: ${path.basename(source)}`);
				}
				if (stat.isDirectory()) {
					await fs.promises.cp(source, dest, { recursive: true, errorOnExist: true });
				} else {
					await fs.promises.cp(source, dest, { errorOnExist: true });
				}
			}),
		);
	}

	// ── Watcher lifecycle ──

	async startWatching(projectId: string): Promise<void> {
		if (this.watchers.has(projectId) || this.pendingWatchers.has(projectId)) return;
		const root = ensureProjectSharedDir(projectId);
		await this.assertSharedRootNotSymlink(root);
		// 共享区是用户文件空间：列表不过滤隐藏文件，watcher 也不过滤，语义保持一致。
		const watcher = chokidar.watch(root, {
			followSymlinks: false,
			ignoreInitial: true,
			persistent: true,
		});
		const entry = { watcher, aborted: false };
		this.pendingWatchers.set(projectId, entry);

		// react-doctor-disable-next-line async-defer-await -- 必须等待 watcher ready 后才能判断并发注册
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: unknown) => {
					watcher.close().catch(() => undefined);
					reject(error);
				};
				watcher.once("ready", () => {
					// ready 后移除 ready 阶段 error 监听，避免运行时 error 触发已消费的 Promise。
					watcher.removeListener("error", onError);
					resolve();
				});
				watcher.once("error", onError);
			});
		} catch (error) {
			this.pendingWatchers.delete(projectId);
			await watcher.close().catch(() => undefined);
			throw error;
		}
		this.pendingWatchers.delete(projectId);

		// ready 前 stopWatching 已标记 aborted，或并发重复注册已就绪：直接关闭本次。
		if (entry.aborted || this.watchers.has(projectId)) {
			await watcher.close();
			return;
		}

		const notify = () => this.scheduleUpdate(projectId);
		watcher
			.on("add", notify)
			.on("change", notify)
			.on("unlink", notify)
			.on("addDir", notify)
			.on("unlinkDir", notify)
			.on("error", (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[Look] shared area watcher error for ${projectId}:`, message);
				// 出错后从登记表移除并关闭，下次 startWatching 可重建，避免残留已关闭实例。
				this.watchers.delete(projectId);
				void watcher.close();
				this.emit({ type: "error", message: `Shared area watcher error: ${message}` });
			});

		this.watchers.set(projectId, watcher);
	}

	async stopWatching(projectId: string): Promise<void> {
		const pending = this.pendingWatchers.get(projectId);
		if (pending) {
			// 标记取消：startWatching 的 ready 回调正常触发后自行 close，避免 await 挂起。
			pending.aborted = true;
		}
		const watcher = this.watchers.get(projectId);
		if (watcher) {
			this.watchers.delete(projectId);
			await watcher.close();
		}
		const pendingUpdate = this.pendingUpdates.get(projectId);
		if (pendingUpdate) {
			clearTimeout(pendingUpdate);
			this.pendingUpdates.delete(projectId);
		}
	}

	private scheduleUpdate(projectId: string): void {
		const existing = this.pendingUpdates.get(projectId);
		if (existing) clearTimeout(existing);
		this.pendingUpdates.set(
			projectId,
			setTimeout(() => {
				this.pendingUpdates.delete(projectId);
				if (!this.watchers.has(projectId)) return;
				this.emit({ type: "shared:updated", projectId });
			}, WATCHER_DEBOUNCE_MS),
		);
	}

	async dispose(): Promise<void> {
		const keys = Array.from(this.watchers.keys());
		await Promise.all(keys.map((id) => this.stopWatching(id)));
		const pendingKeys = Array.from(this.pendingWatchers.keys());
		await Promise.all(
			pendingKeys.map(async (id) => {
				const entry = this.pendingWatchers.get(id);
				if (entry) {
					entry.aborted = true;
					await entry.watcher.close().catch(() => undefined);
				}
				this.pendingWatchers.delete(id);
			}),
		);
	}
}
