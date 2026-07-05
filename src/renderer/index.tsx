import { Toaster } from "@shared/components/ui/sonner";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import { Provider } from "jotai";
import { ThemeProvider } from "next-themes";
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { scan } from "react-scan";
import App from "./App";
import "./App.css";
import i18n from "./i18n";
import { DEFAULT_THEME } from "./lib/look-theme";
import { appStore, initAppData, initIpcHandlers } from "./store/ipcHandler";

if (import.meta.env.DEV) {
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

	(window as any).reactScanReport = (topN = 20) => {
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

	(window as any).reactScanReset = () => {
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
}

const api = (window as any).look;

// IPC event handlers run outside React lifecycle via vanilla Jotai store.
// This decouples high-frequency SDK events from the component tree.
// Register IPC handlers outside React lifecycle.
if (api) initIpcHandlers(api);

// Start loading session summaries and settings immediately.
// This was previously split across multiple useEffect hooks in App.tsx.
if (api) {
	initAppData(api);
}

const root = createRoot(document.getElementById("root")!);
root.render(
	<React.StrictMode>
		<I18nextProvider i18n={i18n}>
			<TooltipProvider>
				<ThemeProvider
					attribute="data-theme"
					defaultTheme={DEFAULT_THEME.tone}
					themes={["light", "dark"]}
					enableSystem={false}
					disableTransitionOnChange
				>
					<Provider store={appStore}>
						<App />
						<Toaster />
					</Provider>
				</ThemeProvider>
			</TooltipProvider>
		</I18nextProvider>
	</React.StrictMode>,
);
