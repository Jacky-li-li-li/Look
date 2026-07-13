// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { getScheduledTaskLocksDir, getScheduledTasksPath, getUiSettingsPath } from "@look/shared/look-storage";
import type { MainToRendererEvent } from "@look/shared/types";
import { app, BrowserWindow, Notification, session, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { syncLookDefaultSkills } from "./agents/default-skills.js";
import { syncLookDefaultAgents } from "./agents/defaults.js";
import { LarkBridgeService } from "./im/lark-bridge-service.js";
import { LarkChannelManager } from "./im/lark-channel-manager.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { promptForProjectTrust } from "./ipc/project-trust.js";
import { AgentScheduledTaskExecutor } from "./scheduler/agent-task-executor.js";
import { SchedulerService } from "./scheduler/scheduler-service.js";
import { FileTaskLock } from "./scheduler/task-lock.js";
import { ScheduledTaskStore } from "./scheduler/task-store.js";
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
let schedulerService: SchedulerService | null = null;
let workspaceFileService: WorkspaceFileService | null = null;
let workspaceTreeService: WorkspaceTreeService | null = null;
let larkChannelManager: LarkChannelManager | null = null;
let larkBridgeService: LarkBridgeService | null = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;

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

	// 阻止 renderer 内嵌窗口/外链导航，只允许经过校验的 https/http 链接走系统浏览器
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (isAllowedExternalUrl(url)) {
			shell.openExternal(url).catch((error) => console.error("[Look] Failed to open external URL:", error));
		}
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		// 允许初始加载的本地/开发服务器 URL；阻止任何外部导航
		if (!isAllowedNavigationUrl(url)) {
			event.preventDefault();
			if (isAllowedExternalUrl(url)) {
				shell.openExternal(url).catch((error) => console.error("[Look] Failed to open external URL:", error));
			}
		}
	});
}

/** 只允许标准 https/http 外部链接通过系统浏览器打开。 */
function isAllowedExternalUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

/** 允许导航到本地打包文件或开发服务器；禁止任何外部 origin。 */
function isAllowedNavigationUrl(raw: string): boolean {
	if (raw === "about:blank") return true;
	try {
		const url = new URL(raw);
		if (url.protocol === "file:") return true;
		if (isDev && url.protocol === "http:" && url.hostname === "localhost" && url.port === "5174") return true;
		return false;
	} catch {
		return false;
	}
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
	const schedulerOwnerId = `${process.pid}:${Date.now()}`;
	schedulerService = new SchedulerService({
		store: new ScheduledTaskStore(getScheduledTasksPath()),
		lock: new FileTaskLock(getScheduledTaskLocksDir(), schedulerOwnerId),
		executor: new AgentScheduledTaskExecutor(runtimeManager),
		ownerId: schedulerOwnerId,
		getProjectInfo: (projectId) => runtimeManager!.getProjectInfo(projectId),
		onAlert: ({ task, log }) => {
			const body = `${task.name}: ${log.errorMessage ?? "Task failed after all retry attempts"}`;
			safeSendEvent({ type: "error", message: body });
			if (Notification.isSupported()) new Notification({ title: "Look scheduled task failed", body }).show();
		},
		onFinished: async ({ task, log }) => {
			const notification = task.notification;
			if (!notification?.enabled) return;
			if (!larkChannelManager) throw new Error("IM channel manager is not available");
			const succeeded = log.status === "success";
			const rawDetail = succeeded ? log.output || "" : log.errorMessage || "";
			const finishedAt = log.finishedAt ?? new Date().toISOString();
			const text = [
				`${succeeded ? "✅" : "❌"} 定时任务「${task.name}」${succeeded ? "执行成功" : "执行失败"}`,
				`时间：${finishedAt}`,
				task.model ? `模型：${task.model}` : undefined,
				rawDetail ? `结果：${rawDetail.slice(0, 1_500)}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			// 先截断再转义：避免转义膨胀（*→\*）导致有效内容被额外压缩
			// Feishu 卡片 markdown 元素支持大段文本，20K 字符远在安全范围内
			const MAX_RESULT = 20_000;
			const snippet =
				rawDetail.length > MAX_RESULT ? `${rawDetail.slice(0, MAX_RESULT)}…[内容过长已截断]` : rawDetail;
			const escaped = snippet.replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/`/g, "\\`");
			const resultContent = rawDetail
				? `**执行结果：**\n${escaped}`
				: succeeded
					? "**执行结果：** （无输出内容）"
					: "**执行结果：** （无错误信息）";
			const card = {
				config: { wide_screen_mode: true },
				header: {
					title: {
						tag: "plain_text" as const,
						content: `${succeeded ? "✅" : "❌"} 定时任务「${task.name}」${succeeded ? "执行成功" : "执行失败"}`,
					},
					template: succeeded ? ("green" as const) : ("red" as const),
				},
				elements: [
					{ tag: "markdown" as const, content: `**任务状态：** ${succeeded ? "成功" : "失败"}` },
					{ tag: "markdown" as const, content: `**执行时间：** ${finishedAt}` },
					...(task.model ? [{ tag: "markdown" as const, content: `**执行模型：** ${task.model}` }] : []),
					{ tag: "markdown" as const, content: resultContent },
				],
			};
			const result = await larkChannelManager.sendTestMessage({
				receiveIdType: "chat_id",
				receiveId: notification.targetChatId,
				text,
				card,
			});
			if (!result.success) throw new Error(result.error ?? "Failed to send IM notification");
		},
	});
	runtimeManager.setSchedulerService(schedulerService);

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
		registerIpcHandlers(runtimeManager, mainWindow, larkChannelManager, larkBridgeService, schedulerService);

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
		await schedulerService.initialize().catch((error) => {
			console.error("[Look] Failed to initialize scheduled tasks:", error);
		});

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
					schedulerService ?? undefined,
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

// Clean up on quit. Prevent the first quit event so asynchronous scheduler,
// channel, watcher, and runtime disposal completes before Electron exits.
async function disposeApplicationServices(): Promise<void> {
	if (schedulerService) {
		try {
			await schedulerService.dispose();
		} catch {
			// best-effort cleanup
		}
	}
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
}

app.on("before-quit", (event) => {
	if (quitCleanupComplete) return;
	event.preventDefault();
	if (quitCleanupStarted) return;
	quitCleanupStarted = true;
	void disposeApplicationServices().finally(() => {
		quitCleanupComplete = true;
		app.quit();
	});
});
