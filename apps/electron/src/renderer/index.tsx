import { Toaster } from "@look/ui/components/ui/sonner";
import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import { Provider } from "jotai";
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
// DEV: 必须在 App 之前导入，确保模块加载时 window.look 已就绪
import "./mockApi";
import App from "./App";
import "./App.css";
import { ErrorBoundary } from "@look/ui/components/ErrorBoundary";
import FileViewerApp from "./FileViewerApp";
import { useLookTheme } from "./hooks/useLookTheme";
import i18n from "./i18n";
import { appStore } from "./store/appStore";
import { initAppData, initIpcHandlers } from "./store/ipcHandler";

// React Scan is intentionally opt-in: its highlight overlays make the normal
// development build visually unusable and distort screenshot-based UI review.
// Append `?react-scan` when profiling renders.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("react-scan")) {
	void import("react-scan").then(({ scan }) => {
		// ---------- react-scan 自动性能分析 ----------
		// 不刷屏，数据存到环形缓冲区，随时在控制台调用 reactScanReport() 查看聚合报告

		const MAX_SAMPLES = 2000;
		const samples: Array<{
			name: string;
			time: number;
			phase: number;
			unnecessary: boolean;
			timestamp: number;
		}> = [];
		const debugWindow = window as typeof window & {
			reactScanReport?: (topN?: number) => void;
			reactScanReset?: () => void;
		};

		debugWindow.reactScanReport = (topN = 20) => {
			if (samples.length === 0) {
				console.log("[React Scan] 暂无渲染数据，请先操作应用再查看。");
				return;
			}

			// 按组件名聚合
			const byName = new Map<
				string,
				{
					total: number;
					slow: number; // >=16ms
					unnecessary: number;
					times: number[];
					phases: Set<number>;
				}
			>();

			for (const s of samples) {
				let entry = byName.get(s.name);
				if (!entry) {
					entry = { total: 0, slow: 0, unnecessary: 0, times: [], phases: new Set() };
					byName.set(s.name, entry);
				}
				entry.total++;
				if (s.time >= 16) entry.slow++;
				if (s.unnecessary) entry.unnecessary++;
				entry.times.push(s.time);
				entry.phases.add(s.phase);
			}

			// 排序：慢渲染次数降序 → 总渲染次数降序
			const sorted = [...byName.entries()]
				.sort((a, b) => b[1].slow - a[1].slow || b[1].total - a[1].total)
				.slice(0, topN);

			const phaseLabel = (p: number) => {
				const labels: string[] = [];
				if (p & 1) labels.push("Mount");
				if (p & 2) labels.push("Update");
				if (p & 4) labels.push("Unmount");
				return labels.join("/");
			};

			const rows = sorted.map(([name, e]) => {
				const avg = e.times.reduce((a, b) => a + b, 0) / e.times.length;
				const max = Math.max(...e.times);
				return {
					组件: name,
					总渲染: e.total,
					"慢渲染(≥16ms)": e.slow,
					无意义渲染: e.unnecessary,
					平均耗时: `${avg.toFixed(1)}ms`,
					最大耗时: `${max.toFixed(1)}ms`,
					阶段: phaseLabel(Array.from(e.phases).reduce((a, b) => a | b, 0)),
				};
			});

			console.log(
				`%c[React Scan] 性能报告（最近 ${samples.length} 条采样，Top ${topN}）`,
				"font-weight:bold;font-size:14px",
			);
			console.table(rows);

			// 总结
			const totalSlow = sorted.reduce((a, [, e]) => a + e.slow, 0);
			const totalUnnecessary = sorted.reduce((a, [, e]) => a + e.unnecessary, 0);
			if (totalSlow > 0 || totalUnnecessary > 0) {
				console.log(
					`%c⚠️ 共 ${totalSlow} 次掉帧 + ${totalUnnecessary} 次无意义渲染 — 优先排查上述组件`,
					"color:#f59e0b",
				);
			} else {
				console.log("%c✅ 未检测到明显的性能问题", "color:#22c55e");
			}
		};

		debugWindow.reactScanReset = () => {
			samples.length = 0;
			console.log("[React Scan] 采样已清空，继续操作后再次 reactScanReport() 查看。");
		};

		scan({
			enabled: true,
			log: false, // 关闭逐条日志，改用 reactScanReport() 聚合查看
			showToolbar: true,
			showNotificationCount: true,
			onRender(_fiber, renders) {
				for (const r of renders) {
					if (samples.length >= MAX_SAMPLES) samples.shift();
					samples.push({
						name: r.componentName ?? "(匿名组件)",
						time: r.time ?? 0,
						phase: r.phase,
						unnecessary: r.unnecessary ?? false,
						timestamp: performance.now(),
					});
				}
			},
		});
	});
}

// DEV: 预览自动更新 toast 各阶段（?preview-update）。
// 循环播放 available → downloading → downloaded，供 UI 走查；
// 不影响打包产物。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview-update")) {
	void import("./store/atoms").then(({ appUpdateAtom }) => {
		const version = "9.9.9";
		let stage: "available" | "downloading" | "downloaded" = "available";
		let percent = 0;
		let elapsed = 0;
		setInterval(() => {
			elapsed += 400;
			switch (stage) {
				case "available":
					appStore.set(appUpdateAtom, { phase: "available", version });
					if (elapsed >= 2400) {
						stage = "downloading";
						elapsed = 0;
					}
					break;
				case "downloading":
					percent = Math.min(100, percent + 4);
					appStore.set(appUpdateAtom, { phase: "downloading", version, percent });
					if (percent >= 100) {
						stage = "downloaded";
						elapsed = 0;
					}
					break;
				case "downloaded":
					appStore.set(appUpdateAtom, { phase: "downloaded", version });
					if (elapsed >= 2400) {
						stage = "available";
						percent = 0;
						elapsed = 0;
					}
					break;
			}
		}, 400);
	});
}

// DEV: 预览个人信息卡（?preview-profile）：注入示例身份数据，
// 打开 设置 → 个人信息 即可查看；不影响打包产物。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview-profile")) {
	void import("./store/authAtoms").then(({ userProfileAtom }) => {
		appStore.set(userProfileAtom, {
			userId: "preview",
			email: "ziwu@look.app",
			userName: "张子午",
			handle: "ziwu",
			avatar: "🦉",
		});
	});
}

const api = window.look;

// 独立文件查看器窗口(?mode=file-viewer):不加载会话/项目数据,不注册主应用 IPC 路由
const isFileViewerMode = new URLSearchParams(window.location.search).get("mode") === "file-viewer";

// IPC event handlers run outside React lifecycle via vanilla Jotai store.
// This decouples high-frequency SDK events from the component tree.
// Register IPC handlers outside React lifecycle.
if (api && !isFileViewerMode) initIpcHandlers(api);

/**
 * 等待主进程 IPC handlers 注册完成（app:ready 信号）。
 *
 * 启动竞态：主进程 createWindow 立即加载渲染进程，但 registerIpcHandlers 在
 * bootstrapApp 的异步初始化（core runtime / projects / im）之后才执行。渲染进程
 * 若在此时发起首次 IPC（profile/settings/agents），会得到
 * `No handler registered for 'look:invoke'`。此函数把首次数据初始化与 React
 * 挂载都推迟到主进程就绪之后；超时兜底 2s（即便信号丢失也不卡死启动）。
 */
function waitForAppReady(api: Window["look"], timeoutMs = 2000): Promise<void> {
	return new Promise((resolve) => {
		if (isFileViewerMode) return resolve();
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearTimeout(timer);
			resolve();
		};
		const unsubscribe = api.onEvent((rawEvent: unknown) => {
			if ((rawEvent as { type?: string }).type === "app:ready") finish();
		});
		const timer = setTimeout(finish, timeoutMs);
	});
}

// 主进程就绪后再启动数据初始化和 React 挂载（启动竞态防护）。
void (async () => {
	await waitForAppReady(api);

	// Start loading session summaries and settings immediately.
	// This was previously split across multiple useEffect hooks in App.tsx.
	if (api && !isFileViewerMode) {
		initAppData(api);
	}

	function ThemedToaster() {
		const { tone } = useLookTheme();
		return <Toaster theme={tone} />;
	}

	const root = createRoot(document.getElementById("root")!);
	root.render(
		<React.StrictMode>
			<I18nextProvider i18n={i18n}>
				<TooltipProvider>
					<Provider store={appStore}>
						<ErrorBoundary>{isFileViewerMode ? <FileViewerApp /> : <App />}</ErrorBoundary>
						<ThemedToaster />
					</Provider>
				</TooltipProvider>
			</I18nextProvider>
		</React.StrictMode>,
	);
})();
