// ============================================================
// GitService — read-only git repo detection for a project cwd
//
// Probes a project directory via the system `git` CLI (fixed arg
// arrays + execFile, no shell) and returns a GitRepoInfo snapshot
// for the status bar. All commands are read-only; failures degrade
// to null fields instead of throwing. Results are cached per cwd
// with a short TTL so frequent renderer polls don't spawn git.
//
// Also exposes a lightweight HEAD watcher (ensureWatcher) so branch
// switches outside the app invalidate the cache and push fresh info
// to the renderer immediately instead of waiting for the next poll.
// ============================================================

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitDiffFile, GitRepoInfo } from "@look/shared/types";
import chokidar, { type FSWatcher } from "chokidar";

const execFileAsync = promisify(execFile);

/** Cache TTL: short enough to notice branch switches, long enough to avoid spawning git per render. */
const CACHE_TTL_MS = 5_000;

/** Per-command timeout — rev-parse/remote are sub-ms on normal repos. */
const GIT_TIMEOUT_MS = 3_000;

const NOT_A_REPO: GitRepoInfo = Object.freeze({
	isRepo: false,
	repoRoot: null,
	branch: null,
	headShort: null,
	remoteName: null,
	remoteUrl: null,
	dirtyCount: 0,
	dirtyAddedLines: 0,
	dirtyDeletedLines: 0,
});

/** git 环境变量：继承宿主 env 时显式清掉会改变仓库解析/索引/配置来源的 key。 */
const GIT_ENV_KEYS_TO_CLEAR = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CEILING_DIRECTORIES",
] as const;

interface CacheEntry {
	at: number;
	info: GitRepoInfo | null;
}

/** getDiff 结果缓存（TTL 与 repo info 一致；切项目/文件变更后 5s 内复用，避免高频切 tab 反复 git diff）。 */
interface DiffCacheEntry {
	at: number;
	files: GitDiffFile[];
}

interface WatchEntry {
	watcher: FSWatcher;
	onChange: () => void;
}

/**
 * git quotePath 转义还原（core.quotePath 默认开启）。
 * git 对含空格/引号/非 ASCII 等特殊字符的路径输出为双引号包裹的转义串：
 * `\t` `\n` `\"` `\\` 与 `\ooo`（UTF-8 字节八进制，非 ASCII 字符逐字节转义）。
 * 无引号包裹时原样返回（如 core.quotePath=false 时的原始 UTF-8 路径）。
 */
export function unquoteGitPath(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	const s = raw.slice(1, -1);
	const bytes: number[] = [];
	let i = 0;
	while (i < s.length) {
		const ch = s.charCodeAt(i);
		if (ch === 92 /* \\ */ && i + 1 < s.length) {
			const next = s[i + 1];
			if (next === "t") {
				bytes.push(9);
				i += 2;
				continue;
			}
			if (next === "n") {
				bytes.push(10);
				i += 2;
				continue;
			}
			if (next === '"') {
				bytes.push(34);
				i += 2;
				continue;
			}
			if (next === "\\") {
				bytes.push(92);
				i += 2;
				continue;
			}
			if (next >= "0" && next <= "7") {
				// 八进制字节序列：1-3 位（git 总是补足 3 位，这里兼容 1-2 位）
				let value = 0;
				let count = 0;
				while (count < 3 && i + 1 + count < s.length && s[i + 1 + count] >= "0" && s[i + 1 + count] <= "7") {
					value = value * 8 + (s.charCodeAt(i + 1 + count) - 48);
					count++;
				}
				bytes.push(value);
				i += 1 + count;
				continue;
			}
			// 未知转义：原样保留反斜杠字符
			bytes.push(ch);
			i += 1;
			continue;
		}
		if (ch < 0x80) {
			bytes.push(ch);
		} else if (ch < 0x800) {
			bytes.push(0xc0 | (ch >> 6), 0x80 | (ch & 0x3f));
		} else {
			bytes.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 0x3f), 0x80 | (ch & 0x3f));
		}
		i += 1;
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

export class GitService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly diffCache = new Map<string, DiffCacheEntry>();
	private readonly watchers = new Map<string, WatchEntry>();

	/** Resolve git info for a project cwd. Returns null when the directory does not exist. */
	async getRepoInfo(projectCwd: string): Promise<GitRepoInfo | null> {
		const cached = this.cache.get(projectCwd);
		if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info;

		const info = await this.probe(projectCwd);
		this.cache.set(projectCwd, { at: Date.now(), info });
		return info;
	}

	/** Drop the cache entry for a cwd (call after branch/remote changes when a watcher is added). */
	invalidate(projectCwd: string): void {
		this.cache.delete(projectCwd);
		this.diffCache.delete(projectCwd);
	}

	clear(): void {
		this.cache.clear();
		this.diffCache.clear();
	}

	/**
	 * Ensure a HEAD watcher for a repo (idempotent). Listens to the resolved
	 * gitdir's HEAD/config so external `git checkout` / remote changes are
	 * picked up instantly: cache invalidated then `onChange()` called.
	 * Returns true when a watcher was newly created.
	 */
	ensureWatcher(projectCwd: string, onChange: () => void): boolean {
		if (this.watchers.has(projectCwd)) return false;
		const gitdir = this.resolveGitDir(projectCwd);
		if (!gitdir) return false;

		const watchPaths = [path.join(gitdir, "HEAD"), path.join(gitdir, "config")].filter((p) => existsSync(p));
		if (watchPaths.length === 0) return false;

		const handler = () => {
			this.invalidate(projectCwd);
			onChange();
		};
		const watcher = chokidar.watch(watchPaths, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
		});
		watcher.on("change", handler).on("add", handler).on("unlink", handler);
		this.watchers.set(projectCwd, { watcher, onChange: handler });
		return true;
	}

	/** Stop the watcher for a cwd (if any). */
	stopWatcher(projectCwd: string): void {
		const entry = this.watchers.get(projectCwd);
		if (!entry) return;
		entry.watcher.close().catch(() => {});
		this.watchers.delete(projectCwd);
	}

	/** Close all watchers (call when the app/window is torn down to avoid leaks). */
	dispose(): void {
		for (const cwd of [...this.watchers.keys()]) this.stopWatcher(cwd);
		this.cache.clear();
		this.diffCache.clear();
	}

	/**
	 * 返回项目的 diff 预览（按文件分组）。tracked 变更来自 `git diff HEAD
	 * --unified=3`；untracked 文件生成全新增伪 diff。上限保护：最多 100 个
	 * 文件、总 patch 2MB，避免超大 diff 阻塞 IPC。
	 */
	async getDiff(projectCwd: string): Promise<GitDiffFile[]> {
		if (!existsSync(projectCwd)) return [];

		const cached = this.diffCache.get(projectCwd);
		if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files.slice();

		const MAX_FILES = 100;
		const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
		const files: GitDiffFile[] = [];
		let totalBytes = 0;

		// 1. tracked 变更（git diff HEAD）
		const patch = await this.git(projectCwd, ["diff", "HEAD", "--unified=3"]);
		if (patch) {
			for (const file of this.parseUnifiedDiff(patch)) {
				if (files.length >= MAX_FILES) break;
				files.push(file);
				totalBytes += file.patch.length;
			}
		}

		// 2. untracked 文件（伪 diff：全新增）
		// ls-files 输出同样受 core.quotePath 转义（含空格/中文路径带引号 + 八进制），需还原
		const untracked = (await this.git(projectCwd, ["ls-files", "--others", "--exclude-standard"])) ?? "";
		for (const raw of untracked.split(/\r?\n/)) {
			const rel = unquoteGitPath(raw.trim());
			if (!rel || files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
			try {
				const full = path.join(projectCwd, rel);
				const stat = statSync(full);
				if (!stat.isFile() || stat.size > MAX_TOTAL_BYTES) continue;
				const buf = readFileSync(full);
				// 二进制（含 NUL 字节）不生成伪 diff：utf8 解码会产生乱码行并渲染进变更列表
				if (buf.includes(0)) continue;
				const lines = buf.toString("utf8").split(/\r?\n/);
				if (lines.at(-1) === "") lines.pop();
				const linesWithPlus = lines.map((l) => `+${l}`).join("\n");
				const pseudo = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length || 1} @@\n${linesWithPlus}`;
				files.push({
					path: rel,
					status: "untracked",
					addedLines: lines.length,
					deletedLines: 0,
					patch: pseudo,
				});
				totalBytes += pseudo.length;
			} catch {
				// 文件消失/无权限 → 跳过
			}
		}

		this.diffCache.set(projectCwd, { at: Date.now(), files });
		return files.slice();
	}

	/** 解析 unified diff 文本为按文件分组的数据。 */
	private parseUnifiedDiff(patch: string): GitDiffFile[] {
		const files: GitDiffFile[] = [];
		let current: { path: string; added: number; deleted: number; lines: string[] } | null = null;

		const flush = () => {
			if (!current) return;
			// git 对「已暂存新增」输出 `new file mode` 头（工作区 diff 的纯新增文件同样如此），
			// 据此标记 added，而不是统一降级为 modified。
			const isNewFile = current.lines.some((l) => l.startsWith("new file mode"));
			const status: GitDiffFile["status"] = isNewFile
				? "added"
				: current.deleted > 0 && current.added === 0
					? "deleted"
					: "modified";
			files.push({
				path: current.path,
				status,
				addedLines: current.added,
				deletedLines: current.deleted,
				patch: current.lines.join("\n"),
			});
			current = null;
		};

		for (const line of patch.split(/\r?\n/)) {
			if (line.startsWith("diff --git ")) {
				flush();
				// a/path b/path → 取 b/ 后路径；头行也保留在 patch 里。
				// git 对特殊字符路径输出引号包裹 + 转义（如 "a/中文 文件.txt" "b/quo\"te.txt"），
				// 此时 b/ 前是闭合引号而非空格；捕获值形如 `path"`（带尾引号）或 `path`，
				// 统一用 unquoteGitPath 还原为真实相对路径。
				const m = line.match(/[" ]b\/(.+)$/);
				const rawPath = m ? m[1] : "";
				const decoded = rawPath.endsWith('"') ? unquoteGitPath(`"${rawPath}`) : rawPath;
				current = {
					path: decoded,
					added: 0,
					deleted: 0,
					lines: [line],
				};
			} else if (current) {
				current.lines.push(line);
				if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
				else if (line.startsWith("-") && !line.startsWith("---")) current.deleted++;
			}
		}
		flush();
		return files;
	}

	private async probe(projectCwd: string): Promise<GitRepoInfo | null> {
		if (!existsSync(projectCwd)) return null;

		// 1. Inside a work tree? 非仓库/在 .git 目录内 → fatal(exit 128) 或 "false"，
		//    统一 catch → null → NOT_A_REPO。
		const inside = await this.git(projectCwd, ["rev-parse", "--is-inside-work-tree"]);
		if (!inside?.trim().toLowerCase().startsWith("true")) return NOT_A_REPO;

		const repoRoot = (await this.git(projectCwd, ["rev-parse", "--show-toplevel"]))?.trim() || null;

		// 2. Current branch — symbolic-ref fails on detached HEAD, fall back to short hash.
		let branch: string | null = null;
		let headShort: string | null = null;
		const symbolic = (await this.git(projectCwd, ["symbolic-ref", "--short", "HEAD"]))?.trim();
		if (symbolic) {
			branch = symbolic;
		} else {
			headShort = (await this.git(projectCwd, ["rev-parse", "--short", "HEAD"]))?.trim() || null;
		}

		// 3. Remote — prefer origin, otherwise the first configured remote.
		let remoteName: string | null = null;
		let remoteUrl: string | null = null;
		const originUrl = (await this.git(projectCwd, ["remote", "get-url", "--", "origin"]))?.trim();
		if (originUrl) {
			remoteName = "origin";
			remoteUrl = originUrl;
		} else {
			const firstRemote = this.firstLine((await this.git(projectCwd, ["remote"])) ?? "");
			if (firstRemote) {
				const url = (await this.git(projectCwd, ["remote", "get-url", "--", firstRemote]))?.trim();
				if (url) {
					remoteName = firstRemote;
					remoteUrl = url;
				}
			}
		}

		// 4. Dirty — 文件总数（porcelain 行数）+ 行级增删（numstat）。
		let dirtyCount = 0;
		const porcelain = await this.git(projectCwd, ["status", "--porcelain"]);
		if (porcelain !== null) {
			dirtyCount = porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
		}

		// 5. 行级 diff：tracked 增删行（git diff HEAD --numstat）+ untracked 文件行数。
		let dirtyAddedLines = 0;
		let dirtyDeletedLines = 0;
		const numstat = await this.git(projectCwd, ["diff", "HEAD", "--numstat"]);
		if (numstat !== null) {
			for (const line of numstat.split(/\r?\n/)) {
				const [added, deleted] = line.trim().split(/\s+/);
				if (!added || !deleted || added === "-" || deleted === "-") continue;
				const a = Number.parseInt(added, 10);
				const d = Number.parseInt(deleted, 10);
				if (Number.isFinite(a)) dirtyAddedLines += a;
				if (Number.isFinite(d)) dirtyDeletedLines += d;
			}
		}
		dirtyAddedLines += await this.countUntrackedLines(projectCwd);

		return {
			isRepo: true,
			repoRoot,
			branch,
			headShort,
			remoteName,
			remoteUrl,
			dirtyCount,
			dirtyAddedLines,
			dirtyDeletedLines,
		};
	}

	/**
	 * Resolve the gitdir for a cwd: `.git` may be a directory (normal repo) or
	 * a file containing `gitdir: <path>` (worktree/submodule).
	 */
	private resolveGitDir(projectCwd: string): string | null {
		const gitPath = path.join(projectCwd, ".git");
		if (!existsSync(gitPath)) return null;
		try {
			if (statSync(gitPath).isDirectory()) return gitPath;
			const content = readFileSync(gitPath, "utf8").trim();
			const match = content.match(/^gitdir:\s*(.+)$/);
			if (match) return path.resolve(projectCwd, match[1].trim());
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * 统计未跟踪文件的行数（加入 +N）。上限保护：最多统计 200 个文件、
	 * 单文件最大 2MB，超出部分按 0 计，避免大仓库/巨型文件拖慢探测。
	 */
	private async countUntrackedLines(projectCwd: string): Promise<number> {
		const MAX_FILES = 200;
		const MAX_FILE_BYTES = 2 * 1024 * 1024;
		const list = (await this.git(projectCwd, ["ls-files", "--others", "--exclude-standard"])) ?? "";
		let total = 0;
		let counted = 0;
		for (const file of list.split(/\r?\n/)) {
			if (!file.trim() || counted >= MAX_FILES) continue;
			try {
				const full = path.join(projectCwd, file.trim());
				const stat = statSync(full);
				if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
				const content = readFileSync(full, "utf8");
				const lines = content.split(/\r?\n/);
				// 末尾换行不算额外一行（与 git diff 语义一致）
				if (lines.at(-1) === "") lines.pop();
				total += lines.length;
				counted++;
			} catch {
				// 文件消失/无权限 → 跳过
			}
		}
		return total;
	}

	/**
	 * 在已知仓库根下按绝对路径取 HEAD 内容（两条 file-head IPC 共用的统一语义）：
	 * - 文件无未提交变更 → null（普通文件视图）
	 * - 文件存在变更且 HEAD 有该文件 → HEAD 内容
	 * - 文件存在变更但 HEAD 无该文件（新增/未跟踪）→ ""（渲染端据此显示「全新增」diff）
	 * - git 命令失败/路径不在仓库内 → null
	 */
	async getFileHeadAtRepo(repoRoot: string, absolutePath: string): Promise<string | null> {
		const rel = absolutePath.startsWith(`${repoRoot}/`) ? absolutePath.slice(repoRoot.length + 1) : null;
		if (!rel) return null;
		// 仅当文件有未提交变更时才返回 HEAD 内容（无变更 = 普通文件视图）；
		// --literal-pathspecs 避免路径中的 glob 特殊字符被当作模式匹配
		const status = await this.git(repoRoot, ["--literal-pathspecs", "status", "--porcelain", "--", rel]);
		if (!status || status.trim().length === 0) return null;
		// HEAD 无此文件（新增/未跟踪）：返回空串标记，而不是失败
		const exists = await this.git(repoRoot, ["cat-file", "-e", `HEAD:${rel}`]);
		if (exists === null) return "";
		return this.git(repoRoot, ["show", `HEAD:${rel}`]);
	}

	/**
	 * 按文件绝对路径向上查找所属 git 仓库，并返回该文件在 HEAD 版本的内容。
	 * 用于独立窗口/Dock 打开文件时自动展示 git 变更对比（无需 projectId）。
	 * @returns { repoRoot, oldContent }；文件不在 git 仓库或失败时返回 null
	 */
	async getFileHeadByAbsolutePath(absolutePath: string): Promise<{ repoRoot: string; oldContent: string } | null> {
		let dir = path.dirname(absolutePath);
		for (let depth = 0; depth < 20; depth++) {
			const gitDir = path.join(dir, ".git");
			if (existsSync(gitDir)) {
				const oldContent = await this.getFileHeadAtRepo(dir, absolutePath);
				if (oldContent === null) return null;
				return { repoRoot: dir, oldContent };
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return null;
	}

	/** Run a read-only git command; returns stdout (trimmed of trailing newline) or null on failure. */
	private async git(projectCwd: string, args: string[]): Promise<string | null> {
		try {
			const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
			for (const key of GIT_ENV_KEYS_TO_CLEAR) delete env[key];
			const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
				cwd: projectCwd,
				timeout: GIT_TIMEOUT_MS,
				encoding: "utf8",
				// 与 readFileContent 的 4MB 读取阈值对齐:1-4MB 文件的完整 diff 不再因 maxBuffer 静默失败
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
				env,
			});
			return stdout;
		} catch {
			return null;
		}
	}

	private firstLine(text: string): string | null {
		const line = text.split(/\r?\n/, 1)[0]?.trim();
		return line ? line : null;
	}
}
