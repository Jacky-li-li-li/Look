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
import { GitService, unquoteGitPath } from "../src/main/git/git-service.js";

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
		expect(info?.dirtyCount).toBe(0);
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
		expect(info?.dirtyCount).toBe(0);
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

	it("行级 diff：+新增行 -删除行（含 untracked）", async () => {
		const dir = makeRepo("lines");
		const service = new GitService();
		expect((await service.getRepoInfo(dir))?.dirtyAddedLines).toBe(0);

		// deleted.txt：先作为已提交文件存在（供后续删除）
		fs.writeFileSync(path.join(dir, "deleted.txt"), "gone\n");
		git(dir, ["add", "deleted.txt"]);
		git(dir, ["commit", "-q", "-m", "add deleted"]);
		// 修改 a.txt：1 行 → 4 行（numstat +3 -0）
		fs.writeFileSync(path.join(dir, "a.txt"), "hello\nl1\nl2\nl3\n");
		// 新增 staged.txt（git add → A，numstat +2 -0）
		fs.writeFileSync(path.join(dir, "staged.txt"), "s1\ns2\n");
		git(dir, ["add", "staged.txt"]);
		// 删除 deleted.txt（unstaged D，numstat +0 -1）
		fs.rmSync(path.join(dir, "deleted.txt"));
		// untracked.txt（3 行，计入 +3）
		fs.writeFileSync(path.join(dir, "untracked.txt"), "u1\nu2\nu3\n");

		// 缓存 TTL 内不会自动刷新，显式失效后重新探测
		service.invalidate(dir);
		const info = await service.getRepoInfo(dir);
		expect(info?.dirtyCount).toBe(4);
		expect(info?.dirtyAddedLines).toBe(8); // 3(修改) + 2(新增) + 3(untracked)
		expect(info?.dirtyDeletedLines).toBe(1);
	});

	it("ensureWatcher：外部切换分支触发 onChange 并失效缓存", async () => {
		const dir = makeRepo("watch");
		const service = new GitService();

		const onChange = vi.fn();
		expect(service.ensureWatcher(dir, onChange)).toBe(true);
		// 幂等：重复 ensure 不重复挂
		expect(service.ensureWatcher(dir, onChange)).toBe(false);

		// 预填充缓存
		const first = await service.getRepoInfo(dir);
		expect(first?.branch).toBe(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]));

		// 外部切到新分支：HEAD 变化 → watcher 触发
		git(dir, ["checkout", "-q", "-b", "feature/x"]);
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000 });

		// 缓存已失效：新分支名被重新探测到（不再返回旧对象）
		const fresh = await service.getRepoInfo(dir);
		expect(fresh).not.toBe(first);
		expect(fresh?.branch).toBe("feature/x");

		service.stopWatcher(dir);
	});

	it("ensureWatcher：非仓库目录不挂 watcher", () => {
		const plain = path.join(tmpRoot, "plain-watch");
		fs.mkdirSync(plain, { recursive: true });
		expect(new GitService().ensureWatcher(plain, vi.fn())).toBe(false);
	});

	it("dispose 关闭所有 watcher", async () => {
		const dir = makeRepo("dispose");
		const service = new GitService();
		const onChange = vi.fn();
		service.ensureWatcher(dir, onChange);
		service.dispose();

		git(dir, ["checkout", "-q", "-b", "after-dispose"]);
		await new Promise((r) => setTimeout(r, 500));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("getDiff 返回按文件分组的 tracked diff（+/- 行统计）", async () => {
		const dir = makeRepo("diff-tracked");
		const service = new GitService();

		// 修改 a.txt：1 行 → 3 行（+2 -0）
		fs.writeFileSync(path.join(dir, "a.txt"), "hello\nl1\nl2\n");

		const files = await service.getDiff(dir);

		expect(files.length).toBe(1);
		expect(files[0]?.path).toBe("a.txt");
		expect(files[0]?.status).toBe("modified");
		expect(files[0]?.addedLines).toBe(2);
		expect(files[0]?.deletedLines).toBe(0);
		expect(files[0]?.patch).toContain("diff --git a/a.txt b/a.txt");
		expect(files[0]?.patch).toContain("+l1");
	});

	it("getDiff 包含 untracked 文件（全新增伪 diff）", async () => {
		const dir = makeRepo("diff-untracked");
		fs.writeFileSync(path.join(dir, "new.txt"), "n1\nn2\nn3\n");

		const files = await new GitService().getDiff(dir);

		const untracked = files.find((f) => f.path === "new.txt");
		expect(untracked).toBeDefined();
		expect(untracked?.status).toBe("untracked");
		expect(untracked?.addedLines).toBe(3);
		expect(untracked?.patch).toContain("+n1");
		expect(untracked?.patch).toContain("@@ -0,0 +1,3 @@");
	});

	it("getDiff：删除文件 status=deleted 且 patch 含 - 行", async () => {
		const dir = makeRepo("diff-deleted");
		fs.writeFileSync(path.join(dir, "del.txt"), "bye\n");
		git(dir, ["add", "del.txt"]);
		git(dir, ["commit", "-q", "-m", "add del"]);
		fs.rmSync(path.join(dir, "del.txt"));

		const files = await new GitService().getDiff(dir);

		const deleted = files.find((f) => f.path === "del.txt");
		expect(deleted).toBeDefined();
		expect(deleted?.status).toBe("deleted");
		expect(deleted?.addedLines).toBe(0);
		expect(deleted?.deletedLines).toBe(1);
	});

	it("getDiff：非仓库/不存在的目录返回空数组", async () => {
		const plain = path.join(tmpRoot, "diff-plain");
		fs.mkdirSync(plain, { recursive: true });
		expect(await new GitService().getDiff(plain)).toEqual([]);
		expect(await new GitService().getDiff(path.join(tmpRoot, "nope"))).toEqual([]);
	});

	describe("getFileHeadByAbsolutePath / getFileHeadAtRepo", () => {
		it("有未提交变更的文件 → 返回 HEAD 内容", async () => {
			const dir = makeRepo("filehead-modified");
			fs.writeFileSync(path.join(dir, "a.txt"), "hello\nworld\n");

			const result = await new GitService().getFileHeadByAbsolutePath(path.join(dir, "a.txt"));

			expect(result).not.toBeNull();
			expect(result?.repoRoot).toBe(dir);
			// git() 返回原始 stdout（不 trim）：文件内容 "hello\n" 原样保留
			expect(result?.oldContent).toBe("hello\n");
		});

		it("无变更的文件 → null（普通文件视图）", async () => {
			const dir = makeRepo("filehead-clean");

			expect(await new GitService().getFileHeadByAbsolutePath(path.join(dir, "a.txt"))).toBeNull();
		});

		it("untracked（新增）文件 → 空串标记（diff 全新增）", async () => {
			const dir = makeRepo("filehead-untracked");
			fs.writeFileSync(path.join(dir, "new-file.ts"), "export const x = 1;\n");

			const result = await new GitService().getFileHeadByAbsolutePath(path.join(dir, "new-file.ts"));

			expect(result).not.toBeNull();
			expect(result?.oldContent).toBe("");
		});

		it("非 git 仓库内的文件 → null", async () => {
			const plain = path.join(tmpRoot, "filehead-plain");
			fs.mkdirSync(plain, { recursive: true });
			fs.writeFileSync(path.join(plain, "x.txt"), "x\n");

			expect(await new GitService().getFileHeadByAbsolutePath(path.join(plain, "x.txt"))).toBeNull();
		});

		it("getFileHeadAtRepo 与自动检测路径语义一致（无变更 null / 新增空串）", async () => {
			const dir = makeRepo("filehead-repo");
			const svc = new GitService();
			fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
			fs.writeFileSync(path.join(dir, "brand-new.md"), "# hi\n");

			expect(await svc.getFileHeadAtRepo(dir, path.join(dir, "a.txt"))).toBe("hello\n");
			expect(await svc.getFileHeadAtRepo(dir, path.join(dir, "brand-new.md"))).toBe("");
			expect(await svc.getFileHeadAtRepo(dir, path.join(dir, "untouched.txt"))).toBeNull();
			expect(await svc.getFileHeadAtRepo(dir, "/outside/repo/file.txt")).toBeNull();
		});
	});

	describe("getDiff 特殊字符路径（quotePath 转义还原）", () => {
		it("含空格/中文文件名的 tracked 变更路径正确解码", async () => {
			const dir = makeRepo("diff-quoted");
			fs.writeFileSync(path.join(dir, "中文 文件.txt"), "v1\n");
			fs.writeFileSync(path.join(dir, "a.txt"), "ok\n");
			git(dir, ["add", "--", "."]);
			git(dir, ["commit", "-q", "-m", "add quoted"]);
			fs.writeFileSync(path.join(dir, "中文 文件.txt"), "v2\n");

			const files = await new GitService().getDiff(dir);

			const quoted = files.find((f) => f.path === "中文 文件.txt");
			expect(quoted).toBeDefined();
			expect(quoted?.status).toBe("modified");
			expect(quoted?.patch).toContain("diff --git");
		});

		it("untracked 中文/空格文件名的伪 diff 路径正确解码", async () => {
			const dir = makeRepo("diff-untracked-quoted");
			fs.writeFileSync(path.join(dir, "新文件 笔记.md"), "# hello\n");

			const files = await new GitService().getDiff(dir);

			const untracked = files.find((f) => f.path === "新文件 笔记.md");
			expect(untracked).toBeDefined();
			expect(untracked?.status).toBe("untracked");
			expect(untracked?.patch).toContain("+# hello");
		});
	});
});

describe("unquoteGitPath（纯函数）", () => {
	it("无引号包裹的路径原样返回", () => {
		expect(unquoteGitPath("src/app.ts")).toBe("src/app.ts");
	});

	it("八进制 UTF-8 字节序列解码为中文", () => {
		expect(unquoteGitPath('"\\344\\270\\255\\346\\226\\207.txt"')).toBe("中文.txt");
	});

	it("空格引号路径原样保留空格", () => {
		expect(unquoteGitPath('"foo bar.txt"')).toBe("foo bar.txt");
	});

	it("转义引号/反斜杠/tab/换行解码", () => {
		expect(unquoteGitPath('"quo\\"te.txt"')).toBe('quo"te.txt');
		expect(unquoteGitPath('"a\\\\b.txt"')).toBe("a\\b.txt");
		expect(unquoteGitPath('"tab\\tfile.txt"')).toBe("tab\tfile.txt");
		expect(unquoteGitPath('"nl\\nfile.txt"')).toBe("nl\nfile.txt");
	});

	it("未知转义保留反斜杠", () => {
		expect(unquoteGitPath('"weird\\q.txt"')).toBe("weird\\q.txt");
	});
});
