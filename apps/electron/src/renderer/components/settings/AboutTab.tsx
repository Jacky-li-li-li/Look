// ============================================================
// AboutTab — 版权页（图标 + 名称）+ 版本志（墨迹时间线）
//
// 设计意图：About 页是这本书的版权页。版本列表是一条竖向时间线：
// 当前版本实心墨点，历史版本空心，点击节点展开该版更新内容。
// 更新控件收敛为「版本记录」标题行右侧的一个图标按钮，
// 状态反馈（进度/结果）以标题行下方的轻量文本呈现。
// ============================================================

import { CircleCheck, Download, Loader2, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import appIconUrl from "../../../../assets/icon-1024.png";
import { CHANGELOG } from "../../data/changelog";
import { useAppUpdate } from "../../hooks/useAppUpdate";

function localize(items: { zh: string; en: string; ja?: string }[], lang: string): string[] {
	return items.map((item) =>
		lang.startsWith("zh") ? item.zh : lang.startsWith("ja") ? (item.ja ?? item.en) : item.en,
	);
}

export default function AboutTab() {
	const { t, i18n } = useTranslation();
	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "1.0.0";
	const { update, checkForUpdates, downloadUpdate, installUpdate } = useAppUpdate();
	const phase = update?.phase;
	const [expanded, setExpanded] = useState<string | null>(null);

	return (
		<div className="flex h-full min-h-0 flex-col items-center overflow-y-auto py-10">
			{/* ── 版权页 ── */}
			<div className="flex flex-col items-center gap-3 text-center">
				<img src={appIconUrl} alt="Look" className="size-[76px] rounded-[22%]" />
				<h2 className="text-lg font-semibold tracking-tight">Look</h2>
			</div>

			{/* ── 版本志 ── */}
			<div className="mt-10 w-full max-w-sm">
				<div className="mb-3 flex items-center justify-between">
					<span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70">
						{t("about.releaseNotes")}
					</span>
					{/* 图标按钮：形态随更新阶段切换 */}
					{phase === "available" ? (
						<button
							type="button"
							onClick={() => void downloadUpdate()}
							title={`${t("update.downloadUpdate")}${update?.version ? ` · v${update.version}` : ""}`}
							aria-label={t("update.downloadUpdate")}
							className="rounded-md p-1.5 text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Download className="size-3.5" />
						</button>
					) : phase === "downloaded" ? (
						<button
							type="button"
							onClick={() => void installUpdate()}
							title={t("update.restartInstall")}
							aria-label={t("update.restartInstall")}
							className="rounded-md p-1.5 text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<RotateCw className="size-3.5" />
						</button>
					) : (
						<button
							type="button"
							disabled={phase === "checking" || phase === "downloading"}
							onClick={() => void checkForUpdates()}
							title={t("update.checkForUpdates")}
							aria-label={t("update.checkForUpdates")}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
						>
							{phase === "checking" || phase === "downloading" ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
						</button>
					)}
				</div>

				{/* 状态反馈行 */}
				{phase === "available" && (
					<p className="-mt-1.5 mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<Download className="size-3" />
						{update?.version ? t("update.versionAvailable", { version: update.version }) : t("update.available")}
					</p>
				)}
				{phase === "not-available" && (
					<p className="-mt-1.5 mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<CircleCheck className="size-3" />
						{t("update.upToDate")}
					</p>
				)}
				{phase === "downloading" && (
					<div className="-mt-1.5 mb-2 flex items-center gap-2">
						<div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary transition-[width]"
								style={{ width: `${Math.round(update?.percent ?? 0)}%` }}
							/>
						</div>
						<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
							{Math.round(update?.percent ?? 0)}%
						</span>
					</div>
				)}
				{phase === "downloaded" && (
					<p className="-mt-1.5 mb-2 text-[11px] text-muted-foreground">
						{t("update.ready")}
						{update?.autoInstallScheduled
							? ` ${t("update.autoRestartHint", { seconds: update.autoRestartInSeconds ?? 5 })}`
							: ""}
					</p>
				)}
				{phase === "error" && (
					<p className="-mt-1.5 mb-2 flex items-start gap-1.5 text-[11px] text-destructive">
						<TriangleAlert className="mt-0.5 size-3 shrink-0" />
						<span className="break-all">{update?.error ?? t("update.failed")}</span>
					</p>
				)}

				<div className="relative ml-[5px] border-l border-hairline pl-5">
					{CHANGELOG.map((entry) => {
						const isCurrent = entry.version === appVersion;
						const isOpen = expanded === entry.version;
						return (
							<div key={entry.version} className="relative pb-1">
								{/* 时间线节点：当前实心，历史空心 */}
								<span
									className={`absolute top-[9px] -left-[25.5px] size-[11px] rounded-full border-2 ${
										isCurrent ? "border-primary bg-primary" : "border-muted-foreground/40 bg-popover"
									}`}
								/>
								<button
									type="button"
									onClick={() => setExpanded(isOpen ? null : entry.version)}
									className="flex w-full items-baseline gap-2 rounded-md py-1.5 pr-1 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className={`font-mono text-[13px] tabular-nums ${isCurrent ? "font-semibold" : ""}`}>
										v{entry.version}
									</span>
									<span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
										{entry.date}
									</span>
									{isCurrent && (
										<span className="rounded-sm bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
											{t("about.current")}
										</span>
									)}
									<span
										className={`ml-auto text-[11px] text-muted-foreground/50 transition-transform duration-200 ${
											isOpen ? "rotate-180" : ""
										}`}
									>
										⌄
									</span>
								</button>
								{/* 下拉抽屉：grid rows 过渡实现平滑展开 */}
								<div
									className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
										isOpen ? "[grid-template-rows:1fr]" : "[grid-template-rows:0fr]"
									}`}
								>
									<ul className="overflow-hidden">
										{localize(entry.items, i18n.language).map((text, index) => (
											<li
												key={`${entry.version}-${index}`}
												className="flex items-start gap-2 py-1 text-[12px] leading-relaxed text-muted-foreground"
											>
												<span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
												{text}
											</li>
										))}
									</ul>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
