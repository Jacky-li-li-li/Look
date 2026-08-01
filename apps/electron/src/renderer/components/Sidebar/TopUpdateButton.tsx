// ============================================================
// TopUpdateButton — 顶部标题行最右侧的更新胶囊按钮
//
// 自动下载模式的主入口：主进程 autoDownload=true，发现新版本后立即自动
// 开始下载。本组件在 available / downloading 阶段展示「更新中」胶囊，
// 边框用 conic-gradient 呈现下载进度（多层背景：进度环覆盖 hairline 基底）
// 并叠加呼吸光效；downloaded 阶段变为「重启更新」按钮，等待用户手动点击
// 重启安装（installUpdate）。
// 仅当存在更新时才渲染；checking / not-available / error 不打扰用户。
// ============================================================

import { useAtomValue } from "jotai";
import { Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { appUpdateAtom } from "../../store/atoms";

export default function TopUpdateButton() {
	const { t } = useTranslation();
	const update = useAtomValue(appUpdateAtom);
	const { installUpdate } = useAppUpdate();
	const phase = update?.phase;

	if (phase !== "available" && phase !== "downloading" && phase !== "downloaded") return null;

	// 下载完成：变为重启按钮，用户手动点击重启安装
	if (phase === "downloaded") {
		return (
			<button
				type="button"
				onClick={() => void installUpdate()}
				title={t("update.ready")}
				className="top-update-restart flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
			>
				<RotateCw className="size-3" />
				{t("update.restartUpdate")}
			</button>
		);
	}

	// available / downloading：自动下载中，边框 conic 进度 + 呼吸光效
	// 文字固定为「更新中」，百分比进度由边框进度环展示
	const progress = phase === "downloading" ? Math.round(update?.percent ?? 0) : 0;
	const clamped = Math.min(100, Math.max(0, progress));
	return (
		<button
			type="button"
			disabled
			aria-label={t("update.downloadingTitle")}
			title={t("update.downloadingTitle")}
			className="top-update-progress flex items-center rounded-full p-[1.5px] disabled:opacity-100"
			style={{
				// 进度环叠加在 hairline 基底上：0% 时有细环轮廓，下载中 primary 弧线覆盖
				background: `conic-gradient(from 0deg, var(--primary) ${clamped * 3.6}deg, transparent ${clamped * 3.6}deg), var(--sidebar-border)`,
			}}
		>
			<span className="relative flex items-center gap-1.5 rounded-full bg-sidebar px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
				<Loader2 className="size-3 animate-spin" />
				{t("update.updating")}
			</span>
		</button>
	);
}
