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
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { ensureProjectSharedDir, getProjectSharedDir } from "../shared/look-storage.js";
import type { FileTreeNode, MainToRendererEvent } from "../shared/types.js";

export type WorkspaceFileServiceEventCallback = (event: MainToRendererEvent) => void;

const WATCHER_DEBOUNCE_MS = 300;
// 共享区是用户文件空间,只过滤隐藏文件,允许导入 node_modules / .git 等
const IGNORED_PATTERNS = [/(^|[/\\])\./];

export class WorkspaceFileService {
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly starting = new Map<string, Promise<void>>();
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

	/**
	 * realpath 的 ENOENT 安全版本:target 不存在时返回 null 而非抛错
	 * 用于 resolveSharedPath 处理"目标尚未创建"的场景(写入新文件等)
	 */
	private async safeRealpath(p: string): Promise<string | null> {
		try {
			return await fs.promises.realpath(p);
		} catch (e: any) {
			if (e?.code === "ENOENT") return null;
			throw e;
		}
	}

	private async resolveSharedPath(projectId: string, relativePath: string): Promise<string> {
		if (typeof relativePath !== "string" || relativePath.length === 0) {
			throw new Error("Invalid path: empty");
		}
		if (path.isAbsolute(relativePath)) {
			throw new Error("Path traversal detected: absolute path");
		}
		const normalized = path.normalize(relativePath);
		if (normalized.startsWith("..") || normalized === "..") {
			throw new Error("Path traversal detected");
		}
		const root = ensureProjectSharedDir(projectId);
		const target = path.resolve(root, normalized);

		// root 必须存在并解析成功
		const realRoot = await this.safeRealpath(root);
		if (!realRoot) throw new Error("Shared area root unavailable");

		const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
		const isInsideRoot = (resolved: string): boolean => resolved === realRoot || resolved.startsWith(prefix);

		const realTarget = await this.safeRealpath(target);
		if (realTarget) {
			if (!isInsideRoot(realTarget)) {
				throw new Error("Path traversal detected: resolved outside shared area");
			}
			return target;
		}

		// target 不存在(写操作将要创建),校验 parent 仍在 root 内,防御 symlink 越界
		const realParent = await this.safeRealpath(path.dirname(target));
		if (realParent && !isInsideRoot(realParent)) {
			throw new Error("Path traversal detected: parent outside shared area");
		}
		return target;
	}

	private async statSafe(targetPath: string): Promise<fs.Stats | null> {
		try {
			return await fs.promises.lstat(targetPath);
		} catch (error: any) {
			if (error?.code === "ENOENT") return null;
			throw error;
		}
	}

	private async readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
		try {
			return await fs.promises.readdir(dirPath, { withFileTypes: true });
		} catch {
			return [];
		}
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
		const root = ensureProjectSharedDir(projectId);
		const entries = await this.readDirEntries(root);
		const nodes = await Promise.all(entries.map((entry) => this.buildNode(entry, root, root)));
		nodes.sort((a, b) => {
			if (a.type === b.type) return a.name.localeCompare(b.name);
			return a.type === "directory" ? -1 : 1;
		});
		return nodes;
	}

	async writeSharedFile(projectId: string, relativePath: string, content: string | Buffer): Promise<void> {
		const target = await this.resolveSharedPath(projectId, relativePath);
		const parent = path.dirname(target);
		await fs.promises.mkdir(parent, { recursive: true });
		// 使用 randomBytes + pid 避免并发写入同名 tmp 文件冲突
		const tempPath = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		try {
			await fs.promises.writeFile(tempPath, content);
			await fs.promises.rename(tempPath, target);
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Drag-drop fallback: write file content provided as base64/utf8 string to
	 * the shared area. Used when webUtils.getPathForFile() cannot return an
	 * absolute path (older Electron, sandboxed renderer, dropped directory where
	 * we have content but no path).
	 *
	 * 安全约束:
	 *   - relativePath 仍需通过 resolveSharedPath 校验,防 `../` 越界
	 *   - 解码后大小不超过 MAX_CONTENT_BYTES(防御 OOM)
	 *   - 二进制内容统一以 base64 字符串形式传输,主端解码
	 */
	async writeSharedContent(
		projectId: string,
		relativePath: string,
		content: string,
		encoding: "base64" | "utf8" = "utf8",
	): Promise<void> {
		const MAX_CONTENT_BYTES = 50 * 1024 * 1024; // 50 MB
		const buffer = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
		if (buffer.byteLength > MAX_CONTENT_BYTES) {
			throw new Error(`Content too large: ${buffer.byteLength} bytes (max ${MAX_CONTENT_BYTES} bytes)`);
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
		// IPC 不可信边界:绝对路径 source 必须位于用户 home 内,防止恶意渲染端
		// 读取任意文件并写入共享区(M-11)。相对路径走 dialog / drag,正常可信。
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		if (!homeDir) {
			throw new Error("Cannot determine user home directory for import");
		}
		const imported: string[] = [];
		try {
			for (const source of sources) {
				const resolved = path.resolve(source);
				if (path.isAbsolute(source) || path.isAbsolute(resolved)) {
					const prefix = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
					if (resolved !== homeDir && !resolved.startsWith(prefix)) {
						throw new Error(`Import source must be within the user home directory: ${source}`);
					}
				}
				const srcStat = await this.statSafe(resolved);
				if (!srcStat) continue;
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
				imported.push(dest);
			}
		} catch (error) {
			// 单条失败时回滚已导入项,避免脏状态
			for (const item of imported) {
				try {
					await fs.promises.rm(item, { recursive: true, force: true });
				} catch {
					// 忽略清理失败
				}
			}
			throw error;
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
		await fs.promises.mkdir(resolvedDest, { recursive: true });
		for (const relativePath of relativePaths) {
			const source = await this.resolveSharedPath(projectId, relativePath);
			const stat = await this.statSafe(source);
			if (!stat) continue;
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
		}
	}

	// ── Watcher lifecycle ──

	async startWatching(projectId: string): Promise<void> {
		if (this.watchers.has(projectId)) return;
		const existing = this.starting.get(projectId);
		if (existing) return existing;
		const promise = this._doStartWatching(projectId);
		this.starting.set(projectId, promise);
		try {
			await promise;
		} finally {
			this.starting.delete(projectId);
		}
	}

	private async _doStartWatching(projectId: string): Promise<void> {
		const root = ensureProjectSharedDir(projectId);
		const watcher = chokidar.watch(root, {
			ignored: IGNORED_PATTERNS,
			ignoreInitial: true,
			persistent: true,
		});

		await new Promise<void>((resolve, reject) => {
			watcher.once("ready", resolve);
			watcher.once("error", (error) => {
				// ready 之前失败时清理 watcher,避免孤儿 chokidar 句柄
				watcher.close().catch(() => undefined);
				reject(error);
			});
		});

		// 等待 ready 后再次检查,防止并发创建多个 watcher
		if (this.watchers.has(projectId)) {
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
				this.emit({ type: "error", message: `Shared area watcher error: ${message}` });
			});

		this.watchers.set(projectId, watcher);
	}

	async stopWatching(projectId: string): Promise<void> {
		const watcher = this.watchers.get(projectId);
		if (!watcher) return;
		this.watchers.delete(projectId);
		await watcher.close();
		const pending = this.pendingUpdates.get(projectId);
		if (pending) {
			clearTimeout(pending);
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
		for (const id of keys) {
			await this.stopWatching(id);
		}
	}
}
