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
	dirtyAdded: 0,
	dirtyDeleted: 0,
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

		// 4. Dirty — one porcelain line per changed/untracked path; split into
		//    +added (A/?/R/M) and -deleted (D) for the diff-style badge.
		let dirtyCount = 0;
		let dirtyAdded = 0;
		let dirtyDeleted = 0;
		const porcelain = await this.git(projectCwd, ["status", "--porcelain"]);
		if (porcelain !== null) {
			for (const line of porcelain.split(/\r?\n/)) {
				if (!line.trim()) continue;
				dirtyCount++;
				const codes = line.slice(0, 2);
				if (codes.includes("D")) dirtyDeleted++;
				else dirtyAdded++; // A/?/R/M/T/C/U 等非删除状态均视为正向变动
			}
		}

		return { isRepo: true, repoRoot, branch, headShort, remoteName, remoteUrl, dirtyCount, dirtyAdded, dirtyDeleted };
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
