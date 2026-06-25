// ============================================================
// WorkspaceTreeService — 项目 cwd 文件树浏览(v0.6)
//
// 设计灵感:
//   - VSCode lazy-load:hasChildren 同步基于 isDirectory,只在 getChildren 调用时 IO
//   - VSCode 仅对已展开目录监听:未展开目录的文件事件忽略
//   - Proma ignore 硬编码 4 套 Set(隐藏 + node_modules + 系统垃圾 + 高噪音)
//   - Proma 安全边界靠白名单(非 ignore)— 我们走 resolveWorkspacePath realpath 校验
//
// 关键差异 vs WorkspaceFileService(v0.5):
//   - 根目录是 ProjectInfo.cwd(动态)而非 ~/.look/shared(固定)
//   - 列表策略:单层 lazy(工作区项目可能有 50k+ 文件)
//   - ignore 列表更激进(共享区只允许用户文件)
//   - watcher 按用户展开的目录动态启动/停止
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import type { FileTreeNode, MainToRendererEvent } from "../shared/types.js";

export type WorkspaceTreeEmitCallback = (event: MainToRendererEvent) => void;

// ---- Ignore lists(Proma 启发,硬编码) ----
const HIDDEN_PATTERN = /(^|[/\\])\./;
const NOISE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	".cache",
	".turbo",
	".parcel-cache",
	".svelte-kit",
	"__pycache__",
	".venv",
	"coverage",
]);
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes"]);

function shouldIgnore(name: string, isDir: boolean): boolean {
	if (HIDDEN_PATTERN.test(name)) return true;
	if (isDir && NOISE_DIRS.has(name)) return true;
	if (!isDir && SYSTEM_FILES.has(name)) return true;
	return false;
}

export class WorkspaceTreeService {
	private readonly watchers = new Map<string, FSWatcher>(); // watcherKey → chokidar watcher
	private readonly watchedByProject = new Map<string, Set<string>>(); // projectId → watcherKey 集合
	private emitCallback: WorkspaceTreeEmitCallback | null = null;

	setEmitCallback(callback: WorkspaceTreeEmitCallback): void {
		this.emitCallback = callback;
	}

	clearEmitCallback(): void {
		this.emitCallback = null;
	}

	private emit(event: MainToRendererEvent): void {
		this.emitCallback?.(event);
	}

	// ── List APIs ──

	/**
	 * 列出指定子目录的一层子项(lazy-load 单层,VSCode 模式)。
	 * relativePath 为 "" 表示项目根(ProjectInfo.cwd)。
	 */
	async listChildren(cwd: string, relativePath: string): Promise<FileTreeNode[]> {
		const target = await this.resolveWorkspacePath(cwd, relativePath);
		const entries = await fs.promises.readdir(target, { withFileTypes: true }).catch(() => []);
		const nodes: FileTreeNode[] = [];
		for (const entry of entries) {
			if (shouldIgnore(entry.name, entry.isDirectory())) continue;
			const absolutePath = path.join(target, entry.name);
			const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			const node: FileTreeNode = {
				name: entry.name,
				path: childRel,
				absolutePath,
				type: entry.isDirectory() ? "directory" : "file",
				// children 字段存在但空数组 = 目录且未加载(渲染端据此判断 hasChildren)
				children: entry.isDirectory() ? [] : undefined,
				extension: entry.isDirectory() ? undefined : path.extname(entry.name).slice(1) || undefined,
				isSymlink: entry.isSymbolicLink(),
				isHidden: entry.name.startsWith("."),
			};
			if (!entry.isDirectory()) {
				try {
					const stat = await fs.promises.lstat(absolutePath);
					node.size = stat.size;
					node.modifiedAt = stat.mtimeMs;
				} catch {
					// 忽略元数据获取失败
				}
			}
			nodes.push(node);
		}
		// 排序:目录优先,然后按 name 字典序;隐藏(. 开头)排到同类末尾
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			const aHidden = a.name.startsWith(".");
			const bHidden = b.name.startsWith(".");
			if (aHidden !== bHidden) return aHidden ? 1 : -1;
			return a.name.localeCompare(b.name);
		});
		return nodes;
	}

	/**
	 * 单节点 stat(用于 hasChildren 同步预测)。
	 * 只 stat 自己,不 readdir 子项。
	 */
	async statNode(cwd: string, relativePath: string): Promise<FileTreeNode | null> {
		const target = await this.resolveWorkspacePath(cwd, relativePath);
		const stat = await fs.promises.lstat(target).catch(() => null);
		if (!stat) return null;
		const name = path.basename(target);
		return {
			name,
			path: relativePath,
			absolutePath: target,
			type: stat.isDirectory() ? "directory" : "file",
			children: stat.isDirectory() ? [] : undefined,
			size: stat.size,
			modifiedAt: stat.mtimeMs,
			isSymlink: stat.isSymbolicLink(),
			isHidden: name.startsWith("."),
		};
	}

	// ── Watcher lifecycle ──

	/**
	 * 启动对指定目录的监听(VSCode 模式:用户展开什么就监听什么)。
	 * depth: 0 只监听该目录的直接子项变化,不递归进子目录。
	 * 重复调用同 projectId+path 是幂等的。
	 */
	startWatchDir(projectId: string, cwd: string, relativePath: string): void {
		const key = this.watcherKey(cwd, relativePath);
		if (this.watchers.has(key)) return;

		const target = path.resolve(cwd, relativePath);
		// 启动前做路径校验,失败静默跳过(VSCode 风格:不抛错打扰用户)
		try {
			const realTarget = fs.realpathSync.native(target);
			const realCwd = fs.realpathSync.native(cwd);
			const prefix = realCwd.endsWith(path.sep) ? realCwd : `${realCwd}${path.sep}`;
			if (realTarget !== realCwd && !realTarget.startsWith(prefix)) {
				// 越界,静默跳过
				return;
			}
		} catch {
			// cwd 不存在等情况,跳过
			return;
		}

		const watcher = chokidar.watch(target, {
			ignored: (watchPath: string) => {
				const base = path.basename(watchPath);
				return shouldIgnore(base, true);
			},
			ignoreInitial: true,
			persistent: true,
			depth: 0,
			// macOS fsevents 对 recursive depth 有限制,depth: 0 更稳
		});

		const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
		const DEBOUNCE_MS = 300;

		watcher.on("all", (_event, changedName) => {
			if (!changedName) return;
			// 单一路径防抖:同一次批量变化只 emit 一次
			const existing = debounceTimers.get(key);
			if (existing) clearTimeout(existing);
			debounceTimers.set(
				key,
				setTimeout(() => {
					debounceTimers.delete(key);
					this.emit({ type: "workspace:updated", projectId, relativePath });
				}, DEBOUNCE_MS),
			);
		});

		watcher.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[Look] workspace tree watcher error: ${message}`);
			// 不主动关闭,chokidar 会自愈;若持续报错下次 startWatchDir 会重复注册
		});

		this.watchers.set(key, watcher);
		let projectSet = this.watchedByProject.get(projectId);
		if (!projectSet) {
			projectSet = new Set();
			this.watchedByProject.set(projectId, projectSet);
		}
		projectSet.add(key);
	}

	stopWatchDir(projectId: string, cwd: string, relativePath: string): void {
		const key = this.watcherKey(cwd, relativePath);
		const watcher = this.watchers.get(key);
		if (!watcher) return;
		this.watchers.delete(key);
		void watcher.close();
		const projectSet = this.watchedByProject.get(projectId);
		if (projectSet) {
			projectSet.delete(key);
			if (projectSet.size === 0) this.watchedByProject.delete(projectId);
		}
	}

	/** 切项目时清理该项目的所有 watcher(防 chokidar 句柄累积) */
	async stopAllWatchesForProject(projectId: string): Promise<void> {
		const keys = this.watchedByProject.get(projectId);
		if (!keys) return;
		await Promise.all(
			Array.from(keys).map(async (key) => {
				const watcher = this.watchers.get(key);
				if (watcher) {
					await watcher.close();
					this.watchers.delete(key);
				}
			}),
		);
		this.watchedByProject.delete(projectId);
	}

	async dispose(): Promise<void> {
		const keys = Array.from(this.watchers.keys());
		await Promise.all(
			keys.map(async (key) => {
				const w = this.watchers.get(key);
				if (w) {
					await w.close();
					this.watchers.delete(key);
				}
			}),
		);
		this.watchedByProject.clear();
	}

	// ── Path helpers ──

	/**
	 * 路径校验:相对 cwd 防 ../ 越界 + realpath 防 symlink 越界。
	 * 与 v0.5 resolveSharedPath 模式同构,但根目录从 shared 目录改为 cwd。
	 */
	private async resolveWorkspacePath(cwd: string, relativePath: string): Promise<string> {
		if (typeof relativePath !== "string") {
			throw new Error("Invalid path");
		}
		if (relativePath === "") return cwd;
		if (path.isAbsolute(relativePath)) {
			throw new Error("Path traversal: absolute path not allowed");
		}
		const normalized = path.normalize(relativePath);
		if (normalized.startsWith("..") || normalized === "..") {
			throw new Error("Path traversal detected");
		}
		const target = path.resolve(cwd, normalized);

		let realTarget: string | null = null;
		let realCwd: string | null = null;
		try {
			realTarget = await fs.promises.realpath(target);
			realCwd = await fs.promises.realpath(cwd);
		} catch (e: any) {
			if (e?.code === "ENOENT") {
				// target 不存在(可能新建中)— 校验 parent 不越界即可
				const realParent = await fs.promises.realpath(path.dirname(target)).catch(() => null);
				if (realCwd && realParent) {
					const prefix = realCwd.endsWith(path.sep) ? realCwd : `${realCwd}${path.sep}`;
					if (realParent !== realCwd && !realParent.startsWith(prefix)) {
						throw new Error("Path traversal: parent outside cwd");
					}
				}
				return target;
			}
			throw e;
		}
		const prefix = realCwd.endsWith(path.sep) ? realCwd : `${realCwd}${path.sep}`;
		if (realTarget !== realCwd && !realTarget.startsWith(prefix)) {
			throw new Error("Path traversal: resolved outside cwd");
		}
		return target;
	}

	private watcherKey(cwd: string, relativePath: string): string {
		// \x00 不能出现在文件系统路径中,比 :: 更安全
		return `${cwd}\x00${relativePath}`;
	}
}
