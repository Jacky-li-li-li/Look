// ============================================================
// TopUpdateButton — 顶部标题行最右侧的更新胶囊按钮
//
// 自动下载模式的主入口：主进程 autoDownload=true，发现新版本后立即自动
// 开始下载。本组件在 available / downloading 阶段展示「更新中」胶囊，
// 边框用 conic-gradient 呈现下载进度（多层背景：进度环覆盖 hairline 基底）
// 并叠加呼吸光效；downloaded 阶段变为「重启更新」按钮，点击后进入
// 「正在重启安装」loading 态（防重复点击，phase 离开 downloaded 时自动复位）；
// error 阶段展示「更新失败」胶囊，点击重新检查（带本地防抖）。
// 仅当存在更新 / 更新失败时才渲染；checking / not-available 不打扰用户。
// 包裹层 role="status" aria-live 让阶段切换（更新中→重启更新→更新失败）对
// 屏幕阅读器可感知；下载百分比在 conic 背景中、不在文本/aria 中，不会高频播报。
// ============================================================

import { useAtomValue } from "jotai";
import { Loader2, RotateCw, TriangleAlert } from "lucide-react";
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
		// 更新失败：destructive 胶囊，点击重新检查更新（本地 retrying 防抖；
		// 打包环境主进程会 emit checking → 组件转瞬消失，开发环境则恢复可点击）
		content = (
			<button
				type="button"
				disabled={retrying}
				onClick={() => {
					setRetrying(true);
					void checkForUpdates().finally(() => setRetrying(false));
				}}
				title={update?.error ?? t("update.failed")}
				className="top-update-error flex h-[28px] items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-70"
			>
				{retrying ? <Loader2 className="size-3 animate-spin" /> : <TriangleAlert className="size-3" />}
				{retrying ? t("update.checking") : t("update.failed")}
			</button>
		);
	} else if (phase === "downloaded") {
		// 下载完成：变为重启按钮，点击后进入 loading 态（禁用防重复点击），
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
				title={installing ? t("update.installing") : t("update.ready")}
				className="top-update-restart flex h-[28px] items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-70"
			>
				{installing ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
				{installing ? t("update.installing") : t("update.restartUpdate")}
			</button>
		);
	} else {
		// available / downloading：自动下载中，边框 conic 进度 + 呼吸光效
		// 文字固定为「更新中」，百分比进度由边框进度环展示
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
				className="top-update-progress flex items-center rounded-full p-[1.5px] disabled:opacity-100"
				style={{
					// 进度环叠加在 hairline 基底上：0% 时有细环轮廓，下载中 primary 弧线覆盖
					background: `conic-gradient(from 0deg, var(--primary) ${clamped * 3.6}deg, transparent ${clamped * 3.6}deg), var(--sidebar-border)`,
				}}
			>
				<span className="relative flex h-[25px] items-center gap-1.5 rounded-full bg-sidebar px-2.5 text-[12px] font-medium text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					{t("update.updating")}
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
