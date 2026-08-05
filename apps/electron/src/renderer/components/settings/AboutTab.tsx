// ============================================================
// AboutTab — 应用身份卡（图标 + 名称 + 版本 + 更新控件）
//            + 版本志卡（墨迹时间线）
//
// 设计意图：与 Profile 页一致，全宽 p-4 + 卡片堆叠布局（与
// GeneralTab/PromptTab 同款），宽窗口下不保留居中列留白。
// 版本列表保留竖向时间线：当前版本实心墨点，历史版本空心，
// 点击展开更新内容。更新控件收敛为身份卡右侧的按钮，状态
// 反馈（进度/结果）以按钮下方的轻量文本呈现。
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from "@look/ui/components/ui/card";
import { CircleCheck, Loader2, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import appIconUrl from "../../../../assets/icon-1024.png";
import feishuIconUrl from "../../assets/feishu.png";
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
	const { update, checkForUpdates, installUpdate } = useAppUpdate();
	const phase = update?.phase;
	const [expanded, setExpanded] = useState<string | null>(null);
	const [showAllVersions, setShowAllVersions] = useState(false);
	const [installing, setInstalling] = useState(false);

	// phase 离开 downloaded（如 quitAndInstall 失败进入 error）时复位 installing，
	// 避免「应用未退出但按钮永久禁用」的卡死。
	useEffect(() => {
		if (phase !== "downloaded") setInstalling(false);
	}, [phase]);

	const visibleChangelog = showAllVersions ? CHANGELOG : CHANGELOG.slice(0, 5);
	const hasMore = CHANGELOG.length > 5;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<div className="flex min-h-0 flex-col gap-3 p-4">
				{/* ── 身份卡：图标 + 名称 + 版本，更新控件与状态反馈右对齐 ── */}
				<Card size="sm">
					<CardContent className="flex items-center gap-4 px-4 py-3.5">
						<img
							src={appIconUrl}
							alt="Look"
							className="size-12 shrink-0 rounded-[22%] ring-1 ring-foreground/10"
						/>
						<div className="min-w-0 flex-1">
							<h2 className="text-[15px] font-semibold tracking-tight">Look</h2>
							<p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">v{appVersion}</p>
						</div>

						{/* 更新控件：按钮形态随阶段切换 */}
						<div className="flex shrink-0 flex-col items-end gap-1.5">
							{phase === "available" ? (
								<button
									type="button"
									disabled
									title={`${t("update.autoDownloading", { version: update?.version ?? "" })}`}
									className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground disabled:opacity-60"
								>
									<Loader2 className="size-3 animate-spin" />
									{t("update.downloadingTitle")}
								</button>
							) : phase === "downloaded" ? (
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
									className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
								>
									{installing ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
									{installing ? t("update.installing") : t("update.restartInstall")}
								</button>
							) : (
								<button
									type="button"
									disabled={phase === "checking" || phase === "downloading"}
									onClick={() => void checkForUpdates()}
									className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
								>
									{phase === "checking" || phase === "downloading" ? (
										<Loader2 className="size-3 animate-spin" />
									) : (
										<RefreshCw className="size-3" />
									)}
									{phase === "checking"
										? t("update.checking")
										: phase === "downloading"
											? t("update.downloadingTitle")
											: t("update.checkForUpdates")}
								</button>
							)}

							{/* 状态反馈：右对齐轻量文本 */}
							{phase === "available" && (
								<p className="text-[11px] text-muted-foreground">
									{t("update.available")}
									{update?.version ? ` v${update.version}` : ""}
								</p>
							)}
							{phase === "not-available" && (
								<p className="flex items-center gap-1 text-[11px] text-muted-foreground">
									<CircleCheck className="size-3" />
									{t("update.upToDate")}
								</p>
							)}
							{phase === "downloading" && (
								<div className="flex w-40 items-center gap-2">
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
								<p className="text-[11px] text-muted-foreground">{t("update.ready")}</p>
							)}
							{phase === "error" && (
								<p className="flex max-w-[220px] items-start gap-1.5 text-[11px] text-destructive">
									<TriangleAlert className="mt-0.5 size-3 shrink-0" />
									<span className="break-all">{update?.error ?? t("update.failed")}</span>
								</p>
							)}
						</div>
					</CardContent>
				</Card>

				{/* ── 版本志卡：墨迹时间线 ── */}
				<Card size="sm">
					<CardHeader className="border-b border-hairline px-4 py-2.5">
						<CardTitle className="text-[13px] font-medium">{t("about.releaseNotes")}</CardTitle>
					</CardHeader>
					<CardContent className="relative px-4 py-3.5">
						<div
							className={`relative ml-[5px] border-l border-hairline pl-5 ${showAllVersions && hasMore ? "pb-10" : ""}`}
						>
							{visibleChangelog.map((entry) => {
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
											<span
												className={`font-mono text-[13px] tabular-nums ${isCurrent ? "font-semibold" : ""}`}
											>
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

						{/* 半透明遮罩：提示还有更多版本（底部半透明确保内容隐约可见，向上渐隐） */}
						{!showAllVersions && hasMore && (
							<div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
								<div
									className="h-24 w-full"
									style={{
										background:
											"linear-gradient(to top, color-mix(in oklch, var(--popover) 92%, transparent) 0%, color-mix(in oklch, var(--popover) 55%, transparent) 55%, transparent 100%)",
									}}
								/>
								<button
									type="button"
									onClick={() => setShowAllVersions(true)}
									className="pointer-events-auto relative -mt-8 rounded-full border border-hairline/70 bg-popover/70 px-3 py-1 text-[11px] text-muted-foreground/70 shadow-none backdrop-blur-sm transition-colors hover:bg-popover/95 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									{t("about.showAll")}
								</button>
							</div>
						)}

						{/* 收起按钮：展开后固定在卡片底部（与「查看全部版本」同位置），随时可折叠回最近版本 */}
						{showAllVersions && hasMore && (
							<div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
								<button
									type="button"
									onClick={() => setShowAllVersions(false)}
									className="pointer-events-auto rounded-full border border-hairline/70 bg-popover/70 px-3 py-1 text-[11px] text-muted-foreground/70 shadow-none backdrop-blur-sm transition-colors hover:bg-popover/95 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									{t("about.showLess")}
								</button>
							</div>
						)}
					</CardContent>
				</Card>

				{/* ── 联系卡：飞书联系方式 ── */}
				<Card size="sm">
					<CardHeader className="border-b border-hairline px-4 py-2.5">
						<CardTitle className="text-[13px] font-medium">{t("about.contactTitle")}</CardTitle>
					</CardHeader>
					<CardContent className="px-4 py-3.5">
						<p className="mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
							{t("about.contactDescription")}
						</p>
						<a
							href="https://www.feishu.cn/invitation/page/add_contact/?token=b42nc543-2547-467b-8a3b-d73db71acce1&unique_id=NfhtWSY6D_FJhaHffrRANQ=="
							target="_blank"
							rel="noopener noreferrer"
							className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<img src={feishuIconUrl} alt="Feishu" className="size-4 rounded object-contain" />
							{t("about.contactButton")}
						</a>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
