// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { getUiSettingsPath } from "@look/shared/look-storage";
import type { MainToRendererEvent } from "@look/shared/types";
import { app, BrowserWindow, session } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { syncLookDefaultSkills } from "./agents/default-skills.js";
import { syncLookDefaultAgents } from "./agents/defaults.js";
import { LarkBridgeService } from "./im/lark-bridge-service.js";
import { LarkChannelManager } from "./im/lark-channel-manager.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { promptForProjectTrust } from "./ipc/project-trust.js";
import { SessionRuntimeManager } from "./session/runtime-manager.js";
import { readThemeToneSync } from "./settings/store.js";
import { loadShellEnv } from "./system/shell-env.js";
import { checkForUpdates, initUpdater } from "./system/updater.js";
import { initializeUsageService } from "./system/usage.js";
import { WorkspaceFileService } from "./workspace/workspace-file-service.js";
import { WorkspaceTreeService } from "./workspace/workspace-tree-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let runtimeManager: SessionRuntimeManager | null = null;
let workspaceFileService: WorkspaceFileService | null = null;
let workspaceTreeService: WorkspaceTreeService | null = null;
let larkChannelManager: LarkChannelManager | null = null;
let larkBridgeService: LarkBridgeService | null = null;

/** 安全向渲染进程推送事件，避免 TOCTOU 窗口销毁竞态导致主进程崩溃。 */
function safeSendEvent(event: MainToRendererEvent): void {
	if (!mainWindow) return;
	try {
		if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	} catch {
		/* window destroyed between check and send */
	}
}

const isDev = !app.isPackaged;

if (isDev) {
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

function bootstrapLarkBridge(): void {
	if (!runtimeManager || !larkChannelManager || !larkBridgeService || !larkChannelManager.getLarkChannel()) {
		return;
	}
	try {
		larkBridgeService.init(runtimeManager, larkChannelManager);
		console.log("[Look] LarkBridgeService initialized");
	} catch (err) {
		console.warn("[Look] Failed to initialize LarkBridgeService:", err);
	}
}

function detachLarkBridge(): void {
	larkBridgeService?.detachChannel();
}

// ============================================================
// Layer 3 — Electron Process Boundary (pi doesn't cover this)
//
// In GUI mode (no terminal), console.warn/error can trigger EPIPE
// because stdout/stderr pipes are disconnected. pi's retry mechanism
// only handles provider-level errors, not process-level I/O errors.
//
// Strategy:
//   1. Safe console wrappers → catch EPIPE, fallback to log file
//   2. uncaughtException → categorize: EPIPE=ignore, others=log+notify
//   3. unhandledRejection → log via IPC to renderer
// ============================================================

function setupProcessBoundary() {
	// Safe write helper — survives broken pipes
	const safeWrite = (level: string, ...args: unknown[]) => {
		const msg = `[${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
		try {
			process.stdout.write(msg);
		} catch {
			/* EPIPE — no terminal */
		}
		try {
			process.stderr.write(msg);
		} catch {
			/* EPIPE — no terminal */
		}
	};

	// Patch console to survive EPIPE (Electron has no real terminal)
	const _log = console.log.bind(console);
	const _warn = console.warn.bind(console);
	const _error = console.error.bind(console);
	console.log = (...args: unknown[]) => {
		try {
			_log(...args);
		} catch {
			safeWrite("info", ...args);
		}
	};
	console.warn = (...args: unknown[]) => {
		try {
			_warn(...args);
		} catch {
			safeWrite("warn", ...args);
		}
	};
	console.error = (...args: unknown[]) => {
		try {
			_error(...args);
		} catch {
			safeWrite("error", ...args);
		}
	};

	// Global exception boundary
	process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
		if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
			return; // Normal in GUI apps — pipe closed, no terminal
		}
		safeWrite("fatal", "Uncaught exception:", err.message, err.stack ?? "");
		try {
			if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
				safeSendEvent({
					type: "error",
					message: `Process error: ${err.message}`,
				});
			}
		} catch {
			/* window destroyed between check and send */
		}
	});

	process.on("unhandledRejection", (reason: unknown) => {
		safeWrite("fatal", "Unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
		try {
			if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
				safeSendEvent({
					type: "error",
					message: `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
				});
			}
		} catch {
			/* window destroyed between check and send */
		}
	});
}

// ============================================================
// Window
// ============================================================

function setupCsp(): void {
	// Dev mode: Vite injects inline scripts for HMR and React Fast Refresh,
	// which would be blocked by strict CSP. Skip CSP entirely on localhost.
	if (isDev) return;

	// The renderer's Supabase client needs to reach its project origin.
	// Parse the configured URL at runtime; fall back to the standard
	// Supabase domain wildcard if the env var isn't visible in main.
	const supabaseOrigin = (() => {
		const url = process.env.VITE_SUPABASE_URL;
		if (!url) return null;
		try {
			return new URL(url).origin;
		} catch {
			return null;
		}
	})();

	const connectSrc = [
		"'self'",
		"http://localhost:*",
		"http://127.0.0.1:*",
		"ws://localhost:*",
		"ws://127.0.0.1:*",
		"https://*.supabase.co",
		...(supabaseOrigin ? [supabaseOrigin] : []),
	].join(" ");

	const csp = [
		`default-src 'self'`,
		`script-src 'self'`,
		`style-src 'self' 'unsafe-inline'`,
		`img-src 'self' data: blob: file:`,
		`font-src 'self' data:`,
		`connect-src ${connectSrc}`,
		`media-src 'self' data: blob: file:`,
		`frame-src 'self' data: blob:`,
		`worker-src 'self' blob:`,
		`object-src 'none'`,
		`base-uri 'self'`,
		`form-action 'none'`,
	].join("; ");

	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				"Content-Security-Policy": [csp],
			},
		});
	});
}

function createWindow(): void {
	const initialTone = readThemeToneSync(getUiSettingsPath());

	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "Look",
		// 使用 persisted theme 的底色，避免启动时暗色窗口底从 repaint 间隙透出。
		backgroundColor: initialTone === "light" ? "#fbfbfa" : "#030202",
		icon: path.join(__dirname, "assets/icon-1024.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL(`http://localhost:5174?theme=${initialTone}`);
		mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"), {
			query: { theme: initialTone },
		});
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

// ============================================================
// Agent Initialization
// Uses pi's retry settings for Layer 1 protection
// ============================================================

async function initSessionRuntime(): Promise<void> {
	loadShellEnv();

	// 共享区服务单例:由 SessionRuntimeManager 持有,以便项目生命周期能驱动 watcher 启停
	workspaceFileService = new WorkspaceFileService();
	// 工作区文件树服务:服务项目 cwd 的 lazy-load 浏览
	workspaceTreeService = new WorkspaceTreeService();
	runtimeManager = new SessionRuntimeManager(workspaceFileService, workspaceTreeService);

	// 1) 加载项目书签（快：只读 projects.json）。
	await runtimeManager.loadProjects();

	// 对从 workspaces 目录恢复出来的 orphan project，必须在 restoreWorkspace 之前完成，
	// 否则这些项目在启动时不会被扫描，导致侧边栏只显示项目而没有会话。
	await runtimeManager.recoverOrphanedProjects().catch((error) => {
		console.error("[Look] Orphaned project recovery failed:", error);
	});

	// The app requires the user to select a project folder first
	// before any agent can be created. Builtin agents are synced below.

	if (mainWindow) {
		larkChannelManager = new LarkChannelManager(mainWindow);
		larkBridgeService = new LarkBridgeService();
		larkChannelManager.onConnectionReady = bootstrapLarkBridge;
		larkChannelManager.onConnectionClosed = detachLarkBridge;

		// 先注册 IPC handler，让 renderer 的 pull / push 都能被处理，
		// 避免 restoreWorkspace 推送的 agent:list 在 renderer 还没准备好时丢失。
		registerIpcHandlers(runtimeManager, mainWindow, larkChannelManager, larkBridgeService);

		// 2) 注册完 handler 后立即推送项目列表，让侧边栏先渲染。
		const allProjects = runtimeManager.listProjects();
		const activeProject = runtimeManager.getActiveProject();
		safeSendEvent({
			type: "project:list" as const,
			projects: allProjects,
			activeProjectId: activeProject?.id ?? null,
		});

		// 3) 扫描所有项目的会话并逐项目推送 agent:list。
		await runtimeManager.restoreWorkspace();

		// 初始化用量统计服务：一次性从历史会话中回算每日轮数。
		initializeUsageService(runtimeManager.listProjects()).catch((error) => {
			console.error("[Look] Failed to initialize usage service:", error);
		});

		const restoredProject = runtimeManager.getActiveProject();
		if (restoredProject) {
			await promptForProjectTrust(runtimeManager, restoredProject.id, mainWindow);
		}

		await larkChannelManager.initialize().catch((err) => {
			console.warn("[Look] Failed to initialize Feishu channel manager:", err);
		});
		bootstrapLarkBridge();

		console.log("[Look] IPC handlers registered");

		// 同步 Look 内置 Skills 到 ~/.look/builtin-skills/ 并注册路径
		try {
			const projectDir = path.resolve(__dirname, "../..");
			const builtinPath = syncLookDefaultSkills(projectDir);
			if (builtinPath) {
				await runtimeManager.importSkillPaths([builtinPath]);
			}
		} catch (err) {
			console.warn("[Look] 同步内置 Skills 失败:", err);
		}

		// 同步 Look 内置 Agent 到 ~/.look/agents/marketplace/
		try {
			const projectDir = path.resolve(__dirname, "../..");
			syncLookDefaultAgents(projectDir);
		} catch (err) {
			console.warn("[Look] 同步内置 Agent 失败:", err);
		}

		// Auto-updater: check for updates 3s after startup
		initUpdater(mainWindow);
		setTimeout(() => {
			checkForUpdates().catch(() => {});
		}, 3000);
	}
}

app.whenReady().then(async () => {
	setupProcessBoundary();
	setupCsp();

	// Set Dock icon on macOS (PNG supported since Electron 20+)
	if (process.platform === "darwin" && app.dock) {
		const iconPath = path.join(__dirname, "assets/icon-1024.png");
		app.dock.setIcon(iconPath);
	}

	createWindow();
	await initSessionRuntime();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
			if (mainWindow && runtimeManager) {
				registerIpcHandlers(
					runtimeManager,
					mainWindow,
					larkChannelManager ?? undefined,
					larkBridgeService ?? undefined,
				);
				larkChannelManager?.setMainWindow(mainWindow);
				const allProjects = runtimeManager.listProjects();
				const activeProject = runtimeManager.getActiveProject();
				safeSendEvent({
					type: "project:list" as const,
					projects: allProjects,
					activeProjectId: activeProject?.id ?? null,
				});
				for (const project of allProjects) {
					const agents = runtimeManager.listAgentsInProject(project.id);
					if (agents.length > 0) {
						safeSendEvent({
							type: "agent:list" as const,
							projectId: project.id,
							agents,
						});
					}
				}
			}
		}
	});
});

app.on("window-all-closed", () => {
	// pi SDK persists each session independently on every completed turn.
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Clean up on quit
// orphaned child processes behind. `dispose()` first tears down the
// shared-area watchers (H-1) and then disposes all agent runtimes.
app.on("before-quit", async () => {
	if (larkBridgeService) {
		try {
			larkBridgeService.dispose();
		} catch {
			// best-effort cleanup
		}
	}
	if (larkChannelManager) {
		try {
			await larkChannelManager.dispose();
		} catch {
			// best-effort cleanup
		}
	}
	if (runtimeManager) {
		try {
			await runtimeManager.dispose();
		} catch {
			// best-effort cleanup
		}
	}
});
