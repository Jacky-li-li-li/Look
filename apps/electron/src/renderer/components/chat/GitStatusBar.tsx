// ============================================================
// GitStatusBar — 会话底部只读 git 状态栏（分支 + 远程短地址）
//
// 订阅 projectGitInfoAtomFamily(projectId)：项目切换时 ChatPanel
// 传入的 projectId 变化 → effect 重新 invoke 主进程 git 探测。
// 为避免外部 checkout/改 remote 后状态栏长期 stale，挂载后每 30s
// （窗口可见时）重新拉取；主进程侧有 5s TTL 缓存兜底，IPC 开销极小。
// 非 git 仓库（info.isRepo=false）时渲染透明内容但保留 20px 槽位：
// 高度恒定保证输入框位置不被顶动，git 信息异步到达后内容淡入。
// ============================================================

import { useAtomValue, useSetAtom } from "jotai";
import { memo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { projectGitInfoAtomFamily } from "../../store/atoms";

interface GitStatusBarProps {
	/** 当前会话绑定的项目 ID（AgentInfo.projectId）；空串时不渲染。 */
	projectId: string;
}

/** 可见时轮询间隔：覆盖「会话内外部 git checkout / 改 remote」的 stale 场景。 */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * 远程 URL → 短格式：https://github.com/xx/yy.git → github.com/xx/yy
 * 同时剥离 userinfo（https://oauth2:TOKEN@host/path → host/path），
 * 避免内嵌凭据泄露到状态栏/截图。
 */
export function shortenRemoteUrl(url: string): string {
	let s = url.trim();
	if (s.startsWith("git@")) {
		// scp-like：git@host:path → host/path（只替换第一个冒号前的 host，端口如 host:2222 视为路径）
		s = s.replace(/^git@([^:]+):/, "$1/");
	} else if (s.startsWith("ssh://")) {
		// ssh://[user[:pass]@]host/path → host/path（保留端口）
		s = s.replace(/^ssh:\/\/(?:[^@/]+@)?/, "");
	} else {
		// https://[user[:pass]@]host/path → host/path
		s = s.replace(/^https?:\/\/(?:[^@/]+@)?/, "");
	}
	if (s.endsWith(".git")) s = s.slice(0, -4);
	return s;
}

const GitStatusBar = memo(function GitStatusBar({ projectId }: GitStatusBarProps) {
	const { t } = useTranslation();
	const info = useAtomValue(projectGitInfoAtomFamily(projectId));
	const setInfo = useSetAtom(projectGitInfoAtomFamily(projectId));

	useEffect(() => {
		if (!projectId) return;
		// 切换项目时先清掉旧值，避免切回旧项目首帧闪现旧分支。
		setInfo(null);

		let cancelled = false;
		const fetchInfo = () => {
			window.look
				.getProjectGitInfo(projectId)
				.then((result) => {
					if (cancelled || !result?.success) return;
					setInfo(result.info);
				})
				.catch((err) => console.warn("[GitStatusBar] getProjectGitInfo failed:", err));
		};

		fetchInfo();
		// 后台 tab 不轮询，避免无谓 IPC；切回可见时下个 tick 由 interval 兜底。
		const timer = setInterval(() => {
			if (document.visibilityState !== "visible") return;
			fetchInfo();
		}, REFRESH_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [projectId, setInfo]);

	// 非 git 仓库 / 探测未完成时也渲染完整的 20px 槽位，只是内容透明（opacity 0）。
	// 高度恒定是“输入框纹丝不动”的关键：ChatInput 在状态栏上方，若状态栏高度
	// 从 0→20px 变化，输入框会被顶动；常驻槽位让输入框位置永远不变，
	// git 信息到达后内容淡入。
	const isRepo = info?.isRepo === true;
	const head = isRepo ? (info.branch ?? info.headShort ?? "") : "";
	const show = isRepo && head.length > 0;

	const remote = show && info.remoteUrl ? shortenRemoteUrl(info.remoteUrl) : null;
	const dirty = show && info.dirtyCount > 0;
	// diff 风格：+新增/修改行（绿），-删除行（红）；只显示非零侧
	const dirtyAddedLabel = show && info.dirtyAddedLines > 0 ? `+${info.dirtyAddedLines}` : null;
	const dirtyDeletedLabel = show && info.dirtyDeletedLines > 0 ? `-${info.dirtyDeletedLines}` : null;
	const dirtyLabel = [dirtyAddedLabel, dirtyDeletedLabel].filter(Boolean).join(" ");
	const headLabel = info?.branch
		? `${t("chat.gitBranch")}: ${info.branch}`
		: `${t("chat.gitDetachedHead")}: ${info?.headShort ?? ""}`;
	const titleParts: string[] = [headLabel];
	if (show && info.repoRoot) titleParts.push(`${t("chat.gitRepoRoot")}: ${info.repoRoot}`);
	if (show && info.remoteUrl) titleParts.push(`${t("chat.gitRemote")}: ${info.remoteUrl}`);
	if (dirty) titleParts.push(`${t("chat.gitDirtyCount")}: ${info.dirtyCount} (${dirtyLabel})`);

	const visible = [head, remote, dirtyLabel].filter(Boolean);

	return (
		<div
			role={show ? "status" : undefined}
			aria-hidden={show ? undefined : true}
			aria-label={show ? visible.join(" · ") : undefined}
			className="flex h-5 shrink-0 items-start gap-1.5 overflow-hidden px-3 pt-[3px] text-muted-foreground/70 transition-opacity duration-150"
			title={show ? titleParts.join("\n") : undefined}
			style={{ opacity: show ? 1 : 0 }}
		>
			<svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="currentColor" aria-hidden="true">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
			</svg>
			<span className="truncate font-mono text-[10px] leading-none">{head}</span>
			{remote && (
				<>
					<span className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground/40" aria-hidden>
						·
					</span>
					<span className="truncate font-mono text-[10px] leading-none">{remote}</span>
				</>
			)}
			{dirty && dirtyLabel && (
				<>
					<span className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground/40" aria-hidden>
						·
					</span>
					<span
						className="shrink-0 rounded px-0.5 font-mono text-[10px] leading-none"
						title={`${t("chat.gitDirtyCount")}: ${info.dirtyCount} (${dirtyLabel})`}
					>
						{dirtyAddedLabel && <span className="text-emerald-500/80">{dirtyAddedLabel}</span>}
						{dirtyDeletedLabel && <span className="text-red-500/80">{dirtyDeletedLabel}</span>}
					</span>
				</>
			)}
		</div>
	);
});

export default GitStatusBar;
