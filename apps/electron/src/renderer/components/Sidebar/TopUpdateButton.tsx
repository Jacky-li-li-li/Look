// ============================================================
// TopUpdateButton — 顶部标题行最右侧的更新图标按钮
//
// 纯图标、无文字（保持 header 按钮组紧凑、不超出侧栏）：
// - available / downloading：下载图标 + conic-gradient 环形下载进度
//   （进度百分比画在按钮外圈，0% 时显示细环轮廓），带呼吸光效；
// - downloaded：图标变为绿色，点击触发 quitAndInstall 重启更新，
//   点击后进入「正在重启安装」loading 态（防重复点击，phase 离开
//   downloaded 时自动复位）；
// - error：红色警示图标，点击重新检查（带本地防抖）。
// 仅当存在更新 / 更新失败时才渲染；checking / not-available 不打扰用户。
// 语义信息全部放在 aria-label / title，屏幕阅读器可感知阶段切换
// （更新中→重启更新→更新失败）；百分比只在视觉环上，不在文本/aria 中。
// ============================================================

import { useAtomValue } from "jotai";
import { Download, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { appUpdateAtom } from "../../store/atoms";

export default function TopUpdateButton() {
	const { t } = useTranslation();
	const update = useAtomValue(appUpdateAtom);
	const { checkForUpdates, installUpdate } = useAppUpdate();
	const [installing, setInstalling] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const phase = update?.phase;

	// phase 离开 downloaded（如 quitAndInstall 失败进入 error）时复位 installing，
	// 避免「应用未退出但按钮永久禁用」的卡死。
	useEffect(() => {
		if (phase !== "downloaded") setInstalling(false);
	}, [phase]);

	if (phase !== "available" && phase !== "downloading" && phase !== "downloaded" && phase !== "error") return null;

	let content: ReactNode;

	if (phase === "error") {
		// 更新失败：红色警示图标，点击重新检查更新（本地 retrying 防抖；
		// 打包环境主进程会 emit checking → 组件转瞬消失，开发环境则恢复可点击）
		content = (
			<button
				type="button"
				disabled={retrying}
				onClick={() => {
					setRetrying(true);
					void checkForUpdates().finally(() => setRetrying(false));
				}}
				aria-label={retrying ? t("update.checking") : t("update.failed")}
				title={update?.error ?? t("update.failed")}
				className="top-update-error flex size-7 shrink-0 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-70"
			>
				{retrying ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}
			</button>
		);
	} else if (phase === "downloaded") {
		// 下载完成：图标变绿，点击重启安装；点击后进入 loading 态（禁用防重复点击），
		// 等待 quitAndInstall 退出应用；installUpdate 失败（如开发环境）时恢复。
		content = (
			<button
				type="button"
				disabled={installing}
				onClick={() => {
					if (installing) return; // 防御：即使按钮尚未 disabled 也阻止重复派发
					setInstalling(true);
					void installUpdate().then((result) => {
						if (!result.success) setInstalling(false);
					});
				}}
				aria-label={installing ? t("update.installing") : t("update.restartUpdate")}
				title={installing ? t("update.installing") : t("update.restartUpdate")}
				className="top-update-restart flex size-7 shrink-0 items-center justify-center rounded-full border border-green-500/40 bg-green-500/10 text-green-500 transition-colors hover:bg-green-500/20 disabled:opacity-70"
			>
				{installing ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
			</button>
		);
	} else {
		// available / downloading：下载图标 + 环形下载进度，百分比由外圈 conic 进度环展示
		const progress = phase === "downloading" ? Math.round(update?.percent ?? 0) : 0;
		const clamped = Math.min(100, Math.max(0, progress));
		// available 刚发现版本（自动下载将开始）时提示带版本号的准确语义；
		// downloading 阶段提示正在下载。
		const statusTitle =
			phase === "available" && update?.version
				? t("update.autoDownloading", { version: update.version })
				: t("update.downloadingTitle");
		content = (
			<button
				type="button"
				disabled
				aria-label={statusTitle}
				title={statusTitle}
				className="top-update-progress flex size-7 shrink-0 items-center justify-center rounded-full p-[1.5px] disabled:opacity-100"
				style={{
					// 进度环叠加在 hairline 基底上：0% 时有细环轮廓，下载中 primary 弧线覆盖
					background: `conic-gradient(from 0deg, var(--primary) ${clamped * 3.6}deg, transparent ${clamped * 3.6}deg), var(--sidebar-border)`,
				}}
			>
				<span className="flex size-full items-center justify-center rounded-full bg-sidebar text-muted-foreground">
					<Download className="size-3.5" />
				</span>
			</button>
		);
	}

	return (
		<div role="status" aria-live="polite" className="inline-flex">
			{content}
		</div>
	);
}
