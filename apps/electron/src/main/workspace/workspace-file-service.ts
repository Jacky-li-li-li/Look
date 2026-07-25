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
import { resolveInsideRoot } from "./path-guard.js";

export type WorkspaceFileServiceEventCallback = (event: MainToRendererEvent) => void;

const WATCHER_DEBOUNCE_MS = 300;
// 共享区是用户文件空间,只过滤隐藏文件,允许导入 node_modules / .git 等
const IGNORED_PATTERNS = [/(^|[/\\])\./];

// 共享区单文件最大字节数(防御 OOM:渲染端可通过 shared:write 提交任意大小字符串)。
// 50 MB 与 drag-drop fallback (writeSharedContent) 对齐,统一上限。
export const SHARED_MAX_CONTENT_BYTES = 50 * 1024 * 1024;

export class WorkspaceFileService {
	private readonly watchers = new Map<string, FSWatcher>();
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
		return resolveInsideRoot({ root, rootName: "shared area", relativePath });
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
		try {
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
			const firstRejection = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
			if (firstRejection) throw firstRejection.reason;
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled" && outcome.value) imported.push(outcome.value);
			}
		} catch (error) {
			await Promise.all(
				imported.map((item) => fs.promises.rm(item, { recursive: true, force: true }).catch(() => undefined)),
			);
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
		if (this.watchers.has(projectId)) return;
		const root = ensureProjectSharedDir(projectId);
		const watcher = chokidar.watch(root, {
			ignored: IGNORED_PATTERNS,
			ignoreInitial: true,
			persistent: true,
		});

		// react-doctor-disable-next-line async-defer-await -- 必须等待 watcher ready 后才能判断并发注册
		await new Promise<void>((resolve, reject) => {
			watcher.once("ready", resolve);
			watcher.once("error", (error) => {
				watcher.close().catch(() => undefined);
				reject(error);
			});
		});

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
		await Promise.all(keys.map((id) => this.stopWatching(id)));
	}
}
