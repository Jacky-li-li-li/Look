// ============================================================
// GitService tests — real temp git repos, system git CLI.
//
// Skips entirely when `git` is unavailable (CI images without git).
// Branch name is read dynamically (git init default differs across
// git versions / init.defaultBranch config).
// ============================================================

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/main/git/git-service.js";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const describeGit = hasGit() ? describe : describe.skip;

describeGit("GitService", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "look-git-test-"));

	afterAll(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	/** Create a temp git repo with one commit; returns its absolute path. */
	function makeRepo(name: string): string {
		const dir = path.join(tmpRoot, name);
		fs.mkdirSync(dir, { recursive: true });
		git(dir, ["init", "-q"]);
		git(dir, ["config", "user.email", "test@look.local"]);
		git(dir, ["config", "user.name", "Look Test"]);
		fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
		git(dir, ["add", "."]);
		git(dir, ["commit", "-q", "-m", "init"]);
		return dir;
	}

	it("识别仓库：分支 + origin 远程地址", async () => {
		const dir = makeRepo("basic");
		git(dir, ["remote", "add", "origin", "https://github.com/foo/bar.git"]);
		const expectedBranch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

		const info = await new GitService().getRepoInfo(dir);

		expect(info).not.toBeNull();
		expect(info?.isRepo).toBe(true);
		// git rev-parse 返回 realpath（macOS 上 /tmp → /private/tmp）
		expect(info?.repoRoot).toBe(fs.realpathSync(dir));
		expect(info?.branch).toBe(expectedBranch);
		expect(info?.headShort).toBeNull();
		expect(info?.remoteName).toBe("origin");
		expect(info?.remoteUrl).toBe("https://github.com/foo/bar.git");
	});

	it("非仓库目录 → isRepo=false，其余字段为 null", async () => {
		const plain = path.join(tmpRoot, "plain");
		fs.mkdirSync(plain, { recursive: true });

		const info = await new GitService().getRepoInfo(plain);

		expect(info).not.toBeNull();
		expect(info?.isRepo).toBe(false);
		expect(info?.repoRoot).toBeNull();
		expect(info?.branch).toBeNull();
		expect(info?.headShort).toBeNull();
		expect(info?.remoteName).toBeNull();
		expect(info?.remoteUrl).toBeNull();
	});

	it("不存在的目录 → null", async () => {
		const info = await new GitService().getRepoInfo(path.join(tmpRoot, "nope"));
		expect(info).toBeNull();
	});

	it("detached HEAD → branch=null、headShort 有值", async () => {
		const dir = makeRepo("detached");
		git(dir, ["checkout", "-q", "--detach"]);
		const expectedHash = git(dir, ["rev-parse", "--short", "HEAD"]);

		const info = await new GitService().getRepoInfo(dir);

		expect(info?.isRepo).toBe(true);
		expect(info?.branch).toBeNull();
		expect(info?.headShort).toBe(expectedHash);
	});

	it("无 remote → remoteName/remoteUrl 为 null", async () => {
		const dir = makeRepo("no-remote");

		const info = await new GitService().getRepoInfo(dir);

		expect(info?.isRepo).toBe(true);
		expect(info?.branch).toBeTruthy();
		expect(info?.remoteName).toBeNull();
		expect(info?.remoteUrl).toBeNull();
	});

	it("无 origin 时取第一个远程", async () => {
		const dir = makeRepo("first-remote");
		git(dir, ["remote", "add", "upstream", "git@github.com:foo/upstream.git"]);

		const info = await new GitService().getRepoInfo(dir);

		expect(info?.remoteName).toBe("upstream");
		expect(info?.remoteUrl).toBe("git@github.com:foo/upstream.git");
	});

	it("无 origin 时多个 remote 取列表第一个", async () => {
		const dir = makeRepo("multi-remote");
		git(dir, ["remote", "add", "upstream", "git@github.com:foo/upstream.git"]);
		git(dir, ["remote", "add", "backup", "https://github.com/foo/backup.git"]);
		const first = git(dir, ["remote"])
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)[0];

		const info = await new GitService().getRepoInfo(dir);

		expect(info?.remoteName).toBe(first);
		expect(info?.remoteUrl).toContain("github.com/foo/");
	});

	it("unborn HEAD（init 后未提交）→ branch 为默认分支、headShort null", async () => {
		const dir = path.join(tmpRoot, "unborn");
		fs.mkdirSync(dir, { recursive: true });
		git(dir, ["init", "-q"]);
		git(dir, ["config", "user.email", "test@look.local"]);
		git(dir, ["config", "user.name", "Look Test"]);

		const info = await new GitService().getRepoInfo(dir);

		expect(info?.isRepo).toBe(true);
		expect(info?.branch).toBe(git(dir, ["symbolic-ref", "--short", "HEAD"]));
		expect(info?.headShort).toBeNull();
	});

	it("TTL 内缓存命中返回同一对象；invalidate 后重新探测", async () => {
		const dir = makeRepo("cache");
		git(dir, ["remote", "add", "origin", "https://github.com/cache/repo.git"]);
		const service = new GitService();

		const first = await service.getRepoInfo(dir);
		// TTL 内修改 remote —— 缓存命中时应返回旧对象（同一引用）。
		git(dir, ["remote", "set-url", "origin", "https://github.com/changed/repo.git"]);
		const second = await service.getRepoInfo(dir);
		expect(second).toBe(first);

		// invalidate 后重新探测应读到新 remote。
		service.invalidate(dir);
		const third = await service.getRepoInfo(dir);
		expect(third?.remoteUrl).toBe("https://github.com/changed/repo.git");
	});

	it("TTL 过期后重新探测（不再返回缓存）", async () => {
		vi.useFakeTimers();
		try {
			const dir = makeRepo("ttl-expire");
			git(dir, ["remote", "add", "origin", "https://github.com/ttl/first.git"]);
			const service = new GitService();

			const first = await service.getRepoInfo(dir);
			git(dir, ["remote", "set-url", "origin", "https://github.com/ttl/second.git"]);

			// TTL 5s 内 → 缓存命中（同一对象）。
			expect(await service.getRepoInfo(dir)).toBe(first);
			// 前进 6s → 缓存过期 → 重新探测到新 remote。
			vi.advanceTimersByTime(6_000);
			const third = await service.getRepoInfo(dir);
			expect(third?.remoteUrl).toBe("https://github.com/ttl/second.git");
		} finally {
			vi.useRealTimers();
		}
	});

	it("继承的 GIT_DIR/GIT_WORK_TREE 被清理，不会解析到错误仓库", async () => {
		const dir = makeRepo("env-clean");
		const otherRepo = makeRepo("env-other");
		const service = new GitService();
		const oldDir = process.env.GIT_DIR;
		const oldWt = process.env.GIT_WORK_TREE;
		process.env.GIT_DIR = path.join(otherRepo, ".git");
		process.env.GIT_WORK_TREE = otherRepo;
		try {
			const info = await service.getRepoInfo(dir);
			expect(info?.isRepo).toBe(true);
			expect(info?.repoRoot).toBe(fs.realpathSync(dir));
		} finally {
			if (oldDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = oldDir;
			if (oldWt === undefined) delete process.env.GIT_WORK_TREE;
			else process.env.GIT_WORK_TREE = oldWt;
		}
	});
});
