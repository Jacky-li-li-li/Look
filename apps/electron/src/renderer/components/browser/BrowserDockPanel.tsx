// ============================================================
// BrowserDockPanel — 内置浏览器面板
//
// 展示 agent 正在操作的浏览器（活动 handle/tab 由主进程 BrowserService
// 维护）。视图区是真实网页：主进程把活动 tab 的 WebContentsView 原生
// 视图盖在 BrowserSlot 占位 div 之上（布局由 BrowserSlot 持续上报），
// 用户直接在页面上点击/滚动/输入，无需坐标映射。
//
// 交互模型（参考 Proma BrowserPanel 的取舍）：
//   - 主进程权威状态 + activity 事件触发即时刷新；
//   - 工具栏走 browser:panel-action（导航/前进后退/切 tab）；
//   - 用户直接在原生视图上点击/滚动/输入（WebContentsView 真实网页）；
//   - 空状态（浏览器未启动）提供「打开浏览器」引导；
//   - about:blank 时叠加就绪引导卡片（pointer-events-none，不挡原生视图）。
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { useAtomValue } from "jotai";
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, LoaderCircle, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { browserPanelOpenAtom, browserStateAtom } from "../../store/browserAtoms";
import { dismissBrowserPanel, pokeBrowserPanelRefresh } from "../../store/browserHandlers";
import { BrowserSlot } from "./BrowserSlot";

/** 面板操作失败的提示驻留时长。 */
const ACTION_ERROR_MS = 4000;

export function BrowserDockPanel() {
	const { t } = useTranslation();
	const open = useAtomValue(browserPanelOpenAtom);
	const state = useAtomValue(browserStateAtom);

	const [urlDraft, setUrlDraft] = useState("");
	const [urlFocused, setUrlFocused] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const lastSyncedUrlRef = useRef<string | null>(null);
	const actionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const running = state?.running ?? false;

	/** 浏览器已就绪但还没有实际页面（面板自启的 about:blank）——叠加引导而非纯白。 */
	const blankTab = running && (state?.url === "about:blank" || !state?.url);

	// 打开时：对账状态（activity 事件已由 browserHandlers 刷新）。
	useEffect(() => {
		if (!open) return;
		void pokeBrowserPanelRefresh();
	}, [open]);

	// URL 输入框跟随当前活动 tab；用户正在输入时不覆写草稿，
	// 且只在 url 实际变化时同步（避免失焦瞬间把草稿冲掉）。
	useEffect(() => {
		if (urlFocused) return;
		if (state?.url !== undefined && state.url !== lastSyncedUrlRef.current) {
			lastSyncedUrlRef.current = state.url;
			setUrlDraft(state.url);
		}
	}, [state?.url, urlFocused]);

	// 卸载时清掉失败提示定时器。
	useEffect(() => {
		return () => {
			if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
		};
	}, []);

	const showActionError = useCallback((message: string) => {
		setActionError(message);
		if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
		actionErrorTimerRef.current = setTimeout(() => setActionError(null), ACTION_ERROR_MS);
	}, []);

	const act = useCallback(
		(action: Parameters<typeof window.look.browserPanelAction>[0]) => {
			void window.look.browserPanelAction(action).then((result) => {
				if (!result?.success) {
					console.warn("[BrowserDockPanel] action failed:", result?.error);
					showActionError(result?.error || t("browser.actionFailed"));
				} else {
					setActionError(null);
				}
				void pokeBrowserPanelRefresh();
			});
		},
		[showActionError, t],
	);

	const handleNavigate = useCallback(async () => {
		const url = urlDraft.trim();
		if (!url) return;
		// 浏览器未启动时先启动（空白页），再导航——用户在空面板直接输入网址即可用。
		if (!running) {
			const launched = await window.look.openBrowserPanel(true).catch((err: unknown) => {
				console.warn("[BrowserDockPanel] openBrowserPanel failed:", err);
				return null;
			});
			if (!launched?.success) {
				showActionError(launched?.error || t("browser.launchFailed"));
				return;
			}
		}
		act({ kind: "navigate", url });
	}, [urlDraft, running, act, showActionError, t]);

	const handleClose = useCallback(() => {
		// dismissBrowserPanel 同时复位 atom 并通知主进程回收面板自启的浏览器。
		dismissBrowserPanel();
	}, []);

	// Dock 容器内渲染（DockFilePanel 的浏览器 tab）：不渲染时由父组件条件控制，
	// 无需 open 检查（保留 open 引用避免 atom 订阅被 tree-shake）。
	if (!open) return null;

	return (
		<div className="flex h-full w-full min-w-0 flex-col bg-background" aria-label={t("browser.panelTitle")}>
			{/* 浏览器 tab 条：多页面切换 + 单独关闭 + 新建 + 关闭面板 */}
			<div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-hairline px-1.5">
				{state?.tabs.map((tab) => (
					<div
						key={tab.name}
						role="tab"
						aria-selected={tab.active}
						className={`group flex h-6 max-w-[150px] shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
							tab.active ? "bg-accent/70 text-foreground" : "text-muted-foreground hover:bg-accent/40"
						}`}
						onClick={() => {
							if (!tab.active) act({ kind: "selectTab", name: tab.name });
						}}
						title={tab.title || tab.url || tab.name}
					>
						<span className="truncate">{tab.title || tab.name}</span>
						<button
							type="button"
							className="flex size-3.5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								act({ kind: "closeTab", name: tab.name });
							}}
							aria-label={t("browser.closeTab")}
						>
							<X className="size-2.5" />
						</button>
					</div>
				))}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button size="icon-sm" variant="ghost" onClick={() => act({ kind: "newTab" })}>
							<Plus className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("browser.newTab")}</TooltipContent>
				</Tooltip>
				<div className="ml-auto flex items-center gap-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button size="icon-sm" variant="ghost" onClick={handleClose}>
								<X className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{t("browser.closePanel")}</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* 工具栏：后退/前进/刷新/URL */}
			<div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1.5">
				<Button size="icon-sm" variant="ghost" disabled={!running} onClick={() => act({ kind: "back" })}>
					<ArrowLeft className="size-3.5" />
				</Button>
				<Button size="icon-sm" variant="ghost" disabled={!running} onClick={() => act({ kind: "forward" })}>
					<ArrowRight className="size-3.5" />
				</Button>
				<Button size="icon-sm" variant="ghost" disabled={!running} onClick={() => act({ kind: "reload" })}>
					<RefreshCw className="size-3.5" />
				</Button>
				<Input
					className="h-7 flex-1 font-mono text-xs"
					placeholder={t("browser.urlPlaceholder")}
					value={urlDraft}
					onChange={(e) => setUrlDraft(e.target.value)}
					onFocus={() => setUrlFocused(true)}
					onBlur={() => setUrlFocused(false)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void handleNavigate();
					}}
				/>
				<Button size="icon-sm" variant="ghost" disabled={!urlDraft.trim()} onClick={() => void handleNavigate()}>
					<ExternalLink className="size-3.5" />
				</Button>
			</div>

			{/* 视图区：原生 WebContentsView（BrowserSlot 上报布局）+ 引导覆盖层 */}
			<div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
				{!running ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
						<LoaderCircle className="size-6 text-muted-foreground/50" />
						<p className="text-sm text-muted-foreground">{t("browser.emptyTitle")}</p>
						<p className="max-w-[260px] text-xs text-muted-foreground/70">{t("browser.emptyDesc")}</p>
						<Button
							size="sm"
							onClick={() => {
								void window.look.openBrowserPanel(true).then(() => pokeBrowserPanelRefresh());
							}}
						>
							{t("browser.openBrowser")}
						</Button>
					</div>
				) : state?.handle && state.activeTab ? (
					<div className="relative h-full w-full">
						{/* key=activeTab：切 tab 时强制重挂 BrowserSlot，lastSentRef 归零，
						    保证首帧必上报新 tab 布局（否则同位置去抖会吞掉首次 show，视图不显示） */}
						<BrowserSlot key={state.activeTab} handle={state.handle} tab={state.activeTab} active />
						{blankTab && (
							<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
								<div className="max-w-[280px] space-y-2 rounded-lg border border-hairline bg-background/90 p-4 text-center shadow-lg backdrop-blur-sm">
									<Globe2 className="mx-auto size-6 text-muted-foreground/60" />
									<p className="text-sm font-medium text-foreground">{t("browser.readyTitle")}</p>
									<p className="text-xs leading-5 text-muted-foreground">{t("browser.readyDesc")}</p>
								</div>
							</div>
						)}
					</div>
				) : (
					<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
						{t("browser.loadingFrame")}
					</div>
				)}
			</div>

			{/* 底部状态行：操作失败时短暂展示错误，否则显示当前页面标题 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-hairline px-2 py-1.5 text-[10px] text-muted-foreground/70">
				{actionError ? (
					<span className="truncate text-destructive" title={actionError}>
						{actionError}
					</span>
				) : (
					<>
						<RotateCcw className="size-3 shrink-0" />
						<span className="truncate">{state?.title || state?.url || t("browser.noActivity")}</span>
						<span className="ml-auto shrink-0">{t("browser.clickHint")}</span>
					</>
				)}
			</div>
		</div>
	);
}
