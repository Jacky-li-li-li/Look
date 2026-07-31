// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { app, protocol } from "electron";
import { Application } from "./application.js";

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

const application = new Application();
// NOTE: Do NOT use a top-level `await` here. In Electron 42 + ESM main-process
// entry, awaiting `application.start()` at the module top level deadlocks
// `app.whenReady()` (the module evaluation is suspended before the ready event
// can be delivered). Run startup asynchronously instead.
void application.start().catch((error) => {
	console.error("[Look] Fatal: Application start failed", error);
});
