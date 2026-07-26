// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { getScheduledTaskLocksDir, getScheduledTasksPath, getUiSettingsPath } from "@look/shared/look-storage";
import type { MainToRendererEvent, ScheduledTaskNotification } from "@look/shared/types";
import { app, BrowserWindow, Notification, protocol, session, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { syncLookDefaultSkills } from "./agents/default-skills.js";
import { syncLookDefaultAgents } from "./agents/defaults.js";
import { HeadlessAgentRunner } from "./execution/headless-agent-runner.js";
import { LarkBridgeService } from "./im/lark-bridge-service.js";
import { LarkChannelManager } from "./im/lark-channel-manager.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { promptForProjectTrust } from "./ipc/project-trust.js";
import { BrowserWindowEventTransport } from "./ipc/renderer-event-transport.js";
import { AgentScheduledTaskExecutor } from "./scheduler/agent-task-executor.js";
import { buildTaskFinishedNotification } from "./scheduler/notification-builder.js";
import { SchedulerService } from "./scheduler/scheduler-service.js";
import { FileTaskLock } from "./scheduler/task-lock.js";
import { ScheduledTaskStore } from "./scheduler/task-store.js";
import { SessionRuntimeManager } from "./session/runtime-manager.js";
import { readThemeToneSync } from "./settings/store.js";
import { initAppUpdater } from "./system/app-updater.js";
import { getBundledResourceRoot } from "./system/bundled-resource-paths.js";
import { registerOAuthProtocol } from "./system/oauth-callback.js";
import { getPackagedRendererIndexPath } from "./system/renderer-paths.js";
import { loadShellEnv } from "./system/shell-env.js";
import { closeViewerWindow } from "./viewer/viewer-window-manager.js";
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

const rendererEvents = new BrowserWindowEventTransport(() => mainWindow);

function safeSendEvent(event: MainToRendererEvent): void {
	rendererEvents.send(event);
}

const isDev = !app.isPackaged;

// OAuth (Supabase GitHub/Google) redirects to look://auth/callback. Mark the
// scheme standard + secure so https pages may navigate to it and Chromium
// parses it with a real host/path. Must run before app ready.
protocol.registerSchemesAsPrivileged([
	{ scheme: "look", privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

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
	if (!runtimeManager || !larkChannelManager || !larkBridgeService) {
		return;
	}
	try {
		// init 是幂等的，且不再要求已有活跃连接：启动时即加载绑定，
		// 之后每个 bot 连接就绪时重复调用都是安全的。
		if (larkBridgeService.init(runtimeManager, larkChannelManager)) {
			console.log("[Look] LarkBridgeService initialized");
		}
	} catch (err) {
		console.warn("[Look] Failed to initialize LarkBridgeService:", err);
	}
}

function detachLarkBridge(appId: string): void {
	// 多连接模型：某个 bot 断开只影响该 bot 的在途回复
	larkBridgeService?.detachChannel(appId);
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
		`img-src 'self' data: blob: file: https:`,
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
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL(`http://localhost:5174?theme=${initialTone}`);
		mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(getPackagedRendererIndexPath(__dirname), {
			query: { theme: initialTone },
		});
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
		// 主窗口关闭时联动关闭独立文件查看器窗口
		closeViewerWindow();
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
// Bootstrap — phased app initialization
//
// Each phase depends only on phases before it. Extracted from the
// former initSessionRuntime() monolith into named functions.
// ============================================================

async function bootstrapApp(): Promise<void> {
	loadShellEnv();

	// Phase 1: Core runtime
	await bootstrapCoreRuntime();

	// Phase 2: Scheduler (depends on runtimeManager)
	schedulerService = createSchedulerService();
	runtimeManager!.setSchedulerService(schedulerService);

	// Phase 3: Load persisted data
	await runtimeManager!.loadProjects();
	await runtimeManager!.recoverOrphanedProjects().catch((error) => {
		console.error("[Look] Orphaned project recovery failed:", error);
	});

	if (!mainWindow) return;

	// Phase 4: IM channels (depends on mainWindow + runtimeManager)
	bootstrapIM();

	// Phase 5: IPC + restore workspace + push initial state
	await bootstrapStartupSequence();

	// Phase 6: Sync built-in skills and agents
	await syncBuiltinResources();
}

// ── Phase 1: Core runtime ──

async function bootstrapCoreRuntime(): Promise<void> {
	workspaceFileService = new WorkspaceFileService();
	workspaceTreeService = new WorkspaceTreeService();
	runtimeManager = await SessionRuntimeManager.create(workspaceFileService, workspaceTreeService);
}

// ── Phase 2: Scheduler ──

function createSchedulerService(): SchedulerService {
	const schedulerOwnerId = `${process.pid}:${Date.now()}`;

	const callbacks = createSchedulerCallbacks();
	return new SchedulerService({
		store: new ScheduledTaskStore(getScheduledTasksPath()),
		lock: new FileTaskLock(getScheduledTaskLocksDir(), schedulerOwnerId),
		executor: new AgentScheduledTaskExecutor(new HeadlessAgentRunner(runtimeManager!)),
		ownerId: schedulerOwnerId,
		getProjectInfo: (projectId) => runtimeManager!.getProjectInfo(projectId),
		resolveNotificationTarget: createImNotificationResolver(),
		onAlert: callbacks.onAlert,
		onFinished: callbacks.onFinished,
	});
}

function createImNotificationResolver() {
	return async (
		notification: ScheduledTaskNotification,
	): Promise<{ chatId: string; channelAppId?: string } | null | undefined> => {
		if (!larkBridgeService) return undefined;
		if (notification.targetChatId && notification.channelAppId) {
			const binding = await larkBridgeService.resolveExplicitTarget(
				notification.channelAppId,
				notification.targetChatId,
			);
			return binding ? { chatId: binding.chatId, channelAppId: binding.appId ?? notification.channelAppId } : null;
		}
		if (notification.targetChatId) {
			const appId = larkBridgeService.getBindings().find((b) => b.chatId === notification.targetChatId)?.appId;
			return { chatId: notification.targetChatId, channelAppId: appId };
		}
		if (notification.channelAppId) {
			const binding = await larkBridgeService.resolveP2pBinding(notification.channelAppId);
			return binding ? { chatId: binding.chatId, channelAppId: notification.channelAppId } : null;
		}
		return null;
	};
}

/** Scheduler notification callbacks, created once at startup. */
function createSchedulerCallbacks() {
	const imResolver = createImNotificationResolver();

	return {
		onAlert: ({ task, log }: { task: { name: string }; log: { errorMessage?: string } }) => {
			const body = `${task.name}: ${log.errorMessage ?? "Task failed after all retry attempts"}`;
			safeSendEvent({ type: "error", message: body });
			if (Notification.isSupported()) new Notification({ title: "Look scheduled task failed", body }).show();
		},
		onFinished: async ({
			task,
			log,
		}: {
			task: { name: string; model?: string; notification?: ScheduledTaskNotification };
			log: { status: string; output?: string; errorMessage?: string; finishedAt?: string };
		}) => {
			const notification = task.notification;
			if (!notification?.enabled) return;
			if (!larkChannelManager) throw new Error("IM channel manager is not available");

			const succeeded = log.status === "success";
			const rawDetail = succeeded ? log.output || "" : log.errorMessage || "";
			const finishedAt = log.finishedAt ?? new Date().toISOString();

			const { text, card } = buildTaskFinishedNotification(task.name, succeeded, finishedAt, task.model, rawDetail);

			const target = await imResolver(notification);
			if (target === undefined) throw new Error("IM bridge is not available");
			if (!target) {
				throw new Error("The selected bot has no private conversation with you yet; message it once in Feishu");
			}
			const result = await larkChannelManager.sendToChat(target.channelAppId, target.chatId, { text, card });
			if (!result.success) throw new Error(result.error ?? "Failed to send IM notification");
		},
	};
}

// ── Phase 4: IM channels ──

function bootstrapIM(): void {
	larkChannelManager = new LarkChannelManager(rendererEvents);
	larkBridgeService = new LarkBridgeService();
	larkChannelManager.onConnectionReady = bootstrapLarkBridge;
	larkChannelManager.onConnectionClosed = detachLarkBridge;
}

// ── Phase 5: IPC registration + workspace restore ──

async function bootstrapStartupSequence(): Promise<void> {
	registerIpcHandlers(
		runtimeManager!.composition,
		mainWindow!,
		rendererEvents,
		larkChannelManager!,
		larkBridgeService!,
		schedulerService!,
	);

	// 启动即初始化桥接（加载持久化绑定，供定时任务 IM 通知解析私聊会话）
	bootstrapLarkBridge();

	// 推送项目列表，让侧边栏先渲染
	const allProjects = runtimeManager!.listProjects();
	const activeProject = runtimeManager!.getActiveProject();
	safeSendEvent({
		type: "project:list" as const,
		projects: allProjects,
		activeProjectId: activeProject?.id ?? null,
	});

	// 扫描所有项目的会话并逐项目推送 agent:list
	await runtimeManager!.restoreWorkspace();

	const restoredProject = runtimeManager!.getActiveProject();
	if (restoredProject) {
		await promptForProjectTrust(runtimeManager!, restoredProject.id, mainWindow!);
	}

	await larkChannelManager!.initialize().catch((err) => {
		console.warn("[Look] Failed to initialize Feishu channel manager:", err);
	});
	bootstrapLarkBridge();
	await schedulerService!.initialize().catch((error) => {
		console.error("[Look] Failed to initialize scheduled tasks:", error);
	});

	console.log("[Look] IPC handlers registered");
}

// ── Phase 6: Built-in resources ──

async function syncBuiltinResources(): Promise<void> {
	const bundledResourceRoot = getBundledResourceRoot({
		isPackaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
		developmentRoot: path.resolve(__dirname, "../../.."),
	});

	try {
		const builtinPath = syncLookDefaultSkills(bundledResourceRoot);
		if (builtinPath) {
			await runtimeManager!.importSkillPaths([builtinPath]);
		}
	} catch (err) {
		console.warn("[Look] 同步内置 Skills 失败:", err);
	}

	try {
		syncLookDefaultAgents(bundledResourceRoot);
	} catch (err) {
		console.warn("[Look] 同步内置 Agent 失败:", err);
	}
}

app.whenReady().then(async () => {
	setupProcessBoundary();
	setupCsp();
	registerOAuthProtocol();

	// Set Dock icon on macOS (PNG supported since Electron 20+)
	if (process.platform === "darwin" && app.dock) {
		const iconPath = path.join(__dirname, "assets/icon-1024.png");
		app.dock.setIcon(iconPath);
	}

	createWindow();
	initAppUpdater(safeSendEvent);
	try {
		await bootstrapApp();
	} catch (err) {
		console.error("[Look] Fatal: Application bootstrap failed — quitting", err);
		app.quit();
		return;
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
			if (mainWindow && runtimeManager) {
				registerIpcHandlers(
					runtimeManager.composition,
					mainWindow,
					rendererEvents,
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
		} catch (err) {
			console.error("[Look] schedulerService dispose failed:", err);
		}
		schedulerService = null;
	}
	if (larkBridgeService) {
		try {
			larkBridgeService.dispose();
		} catch (err) {
			console.error("[Look] larkBridgeService dispose failed:", err);
		}
		larkBridgeService = null;
	}
	if (larkChannelManager) {
		try {
			await larkChannelManager.dispose();
		} catch (err) {
			console.error("[Look] larkChannelManager dispose failed:", err);
		}
		larkChannelManager = null;
	}
	if (runtimeManager) {
		try {
			await runtimeManager.dispose();
		} catch (err) {
			console.error("[Look] runtimeManager dispose failed:", err);
		}
		runtimeManager = null;
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
