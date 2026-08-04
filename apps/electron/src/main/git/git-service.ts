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
import type { GitRepoInfo } from "@look/shared/types";
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

interface WatchEntry {
	watcher: FSWatcher;
	onChange: () => void;
}

export class GitService {
	private readonly cache = new Map<string, CacheEntry>();
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
	}

	clear(): void {
		this.cache.clear();
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

	/** Run a read-only git command; returns stdout (trimmed of trailing newline) or null on failure. */
	private async git(projectCwd: string, args: string[]): Promise<string | null> {
		try {
			const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
			for (const key of GIT_ENV_KEYS_TO_CLEAR) delete env[key];
			const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
				cwd: projectCwd,
				timeout: GIT_TIMEOUT_MS,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
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
