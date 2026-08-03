// ============================================================
// Git repo read-only info — auto-detected from a project's cwd
// ============================================================

/** Git 仓库只读信息（自动识别结果，供状态栏/后续 git UI 使用） */
export interface GitRepoInfo {
	/** 是否位于 git 仓库内 */
	isRepo: boolean;
	/** 仓库根目录（git rev-parse --show-toplevel），非仓库时 null */
	repoRoot: string | null;
	/** 当前分支名；detached HEAD 或非仓库时为 null */
	branch: string | null;
	/** detached HEAD 时的短 commit hash（正常分支时为 null） */
	headShort: string | null;
	/** 远程名称（优先 origin，否则第一个 remote），无 remote 时 null */
	remoteName: string | null;
	/** 远程 URL（https/git@ 原样），无 remote 时 null */
	remoteUrl: string | null;
}
