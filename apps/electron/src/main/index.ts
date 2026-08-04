// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { app, protocol } from "electron";
import { resolveDevLookHome } from "./system/dev-look-home.js";

// OAuth (Supabase GitHub/Google) redirects to look://auth/callback. Mark the
// scheme standard + secure so https pages may navigate to it and Chromium
// parses it with a real host/path. Must run before app ready.
protocol.registerSchemesAsPrivileged([
	{ scheme: "look", privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

if (!app.isPackaged) {
	// Vite dev server needs relaxed CSP for HMR; keep Electron's warning out of
	// the development console while leaving packaged security checks intact.
	process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

// Disable GPU / sandbox when running in a sandboxed/container environment
// without hardware acceleration (e.g. Trae sandbox, CI, Docker)
if (process.env.SANDBOX_GPU_WORKAROUND === "1") {
	app.commandLine.appendSwitch("no-sandbox");
	app.commandLine.appendSwitch("disable-gpu-sandbox");
	app.commandLine.appendSwitch("in-process-gpu");
}

// 禁用 macOS 系统 overlay 滚动条：让消息区（look-message-scrollbar）的
// 自定义 2px 样式完全接管，hover 滚动条轨道时不再被系统膨胀（系统会把
// thumb 放大到可拖动尺寸）。副作用：所有滚动区域变为传统常显模式
// （侧栏等本就常显，不受影响）；消息区仍由 CSS 控制静止隐藏/滚动显示。
app.commandLine.appendSwitch("disable-features", "OverlayScrollbar");

// dev（未打包）与正式版业务数据目录隔离：dev 使用独立的 ~/.look-dev，
// 避免 dev 测试产生的会话/项目/设置污染正式版的 ~/.look。
// 外部显式设置 LOOK_HOME（CI/测试/用户）优先，不覆盖。
//
// 关键时序：look-storage 在模块加载时缓存 LOOK_DIR，因此必须在任何
// look-storage 依赖模块加载之前设置 LOOK_HOME —— 下方 Application 必须
// 使用动态 import（不要改回静态 import，否则 LOOK_HOME 设置会失效）。
const devLookHome = resolveDevLookHome(app.isPackaged, process.env.LOOK_HOME);
if (devLookHome) process.env.LOOK_HOME = devLookHome;

// Dynamic import ensures LOOK_HOME is set before look-storage evaluates.
// NOTE: Do NOT use a top-level `await` here. In Electron 42 + ESM main-process
// entry, awaiting `application.start()` at the module top level deadlocks
// `app.whenReady()` (the module evaluation is suspended before the ready event
// can be delivered). Run startup asynchronously instead.
void import("./application.js").then(({ Application }) => {
	const application = new Application();
	void application.start().catch((error) => {
		console.error("[Look] Fatal: Application start failed", error);
	});
});
