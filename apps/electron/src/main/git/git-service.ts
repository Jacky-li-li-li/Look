// ============================================================
// GitService — read-only git repo detection for a project cwd
//
// Probes a project directory via the system `git` CLI (fixed arg
// arrays + execFile, no shell) and returns a GitRepoInfo snapshot
// for the status bar. All commands are read-only; failures degrade
// to null fields instead of throwing. Results are cached per cwd
// with a short TTL so frequent renderer polls don't spawn git.
// ============================================================

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { GitRepoInfo } from "@look/shared/types";

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

export class GitService {
	private readonly cache = new Map<string, CacheEntry>();

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

		return { isRepo: true, repoRoot, branch, headShort, remoteName, remoteUrl };
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
