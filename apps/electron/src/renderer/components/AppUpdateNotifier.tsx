// ============================================================
// AppUpdateNotifier — 全局自动更新提示（sonner toast）
//
// 订阅 appUpdateAtom（由主进程 update:status 事件驱动），
// 用固定 toast id 原地更新：available → downloading → downloaded。
// downloaded 后主进程会在数秒后自动重启安装，toast 提供
// 「立即重启」和「取消自动重启」（退回手动）两个出口。
// 仅在发现新版本后才出现；checking / not-available / error 不打扰用户
// （手动检查的结果在设置页 AboutTab 展示）。
// ============================================================

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { appUpdateAtom } from "../store/atoms";

const TOAST_ID = "app-update";

export default function AppUpdateNotifier() {
	const { t } = useTranslation();
	const update = useAtomValue(appUpdateAtom);
	const { downloadUpdate, installUpdate, cancelAutoInstall } = useAppUpdate();

	useEffect(() => {
		if (!update) return;
		switch (update.phase) {
			case "available":
				toast(t("update.available"), {
					id: TOAST_ID,
					description: update.version ? t("update.versionAvailable", { version: update.version }) : undefined,
					duration: Number.POSITIVE_INFINITY,
					action: { label: t("update.download"), onClick: () => void downloadUpdate() },
					cancel: { label: t("update.later"), onClick: () => {} },
				});
				break;
			case "downloading": {
				const percent = Math.round(update.percent ?? 0);
				toast.custom(
					() => (
						<div className="w-[300px] rounded-xl border border-hairline bg-popover px-4 py-3 shadow-lg">
							<div className="mb-2 text-[12px] font-medium">{t("update.downloadingTitle")}</div>
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none"
									style={{ width: `${percent}%` }}
								/>
							</div>
							<div className="mt-1.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
								{percent}%
							</div>
						</div>
					),
					{ id: TOAST_ID, duration: Number.POSITIVE_INFINITY },
				);
				break;
			}
			case "downloaded":
				// 取消状态由主进程拥有：取消后主进程会 re-emit downloaded +
				// autoInstallScheduled:false，此 effect 随状态切换到手动变体。
				if (update.autoInstallScheduled) {
					toast(t("update.ready"), {
						id: TOAST_ID,
						description: t("update.autoRestartHint", { seconds: update.autoRestartInSeconds ?? 5 }),
						duration: Number.POSITIVE_INFINITY,
						action: { label: t("update.restart"), onClick: () => void installUpdate() },
						cancel: {
							label: t("update.cancelAutoRestart"),
							onClick: () => void cancelAutoInstall(),
						},
					});
				} else {
					toast(t("update.ready"), {
						id: TOAST_ID,
						description: update.version,
						duration: Number.POSITIVE_INFINITY,
						action: { label: t("update.restart"), onClick: () => void installUpdate() },
						cancel: { label: t("update.later"), onClick: () => {} },
					});
				}
				break;
			default:
				toast.dismiss(TOAST_ID);
				break;
		}
	}, [update, t, downloadUpdate, installUpdate, cancelAutoInstall]);

	return null;
}
