// ============================================================
// Application — phased app lifecycle
//
// Extracted from index.ts to own the mutable service state,
// eliminate module-level let variables, and enable testing.
// ============================================================

import { getScheduledTaskLocksDir, getScheduledTasksPath, getUiSettingsPath } from "@look/shared/look-storage";
import type { MainToRendererEvent, ScheduledTaskNotification } from "@look/shared/types";
import { app, BrowserWindow, Notification, powerMonitor, session, shell } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
import { SessionRuntimeManager } from "./session/runtime/runtime-manager.js";
import { readThemeToneSync } from "./settings/store.js";
import { initAppUpdater, replayUpdateStatus, requestFreshCheck } from "./system/app-updater.js";
import { getBundledResourceRoot } from "./system/bundled-resource-paths.js";
import { registerOAuthProtocol } from "./system/oauth-callback.js";
import { getPackagedRendererIndexPath } from "./system/renderer-paths.js";
import { loadShellEnv } from "./system/shell-env.js";
import { TRAFFIC_LIGHT_INITIAL_Y, TRAFFIC_LIGHT_X } from "./system/traffic-light.js";
import { closeViewerWindow } from "./viewer/viewer-window-manager.js";
import { WorkspaceFileService } from "./workspace/workspace-file-service.js";
import { WorkspaceTreeService } from "./workspace/workspace-tree-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ApplicationServices {
	mainWindow: BrowserWindow | null;
	runtimeManager: SessionRuntimeManager | null;
	schedulerService: SchedulerService | null;
	workspaceFileService: WorkspaceFileService | null;
	workspaceTreeService: WorkspaceTreeService | null;
	larkChannelManager: LarkChannelManager | null;
	larkBridgeService: LarkBridgeService | null;
}

export class Application {
	readonly services: ApplicationServices;
	private rendererEvents = new BrowserWindowEventTransport(() => this.services.mainWindow);
	private _disposing = false;
	/** 主进程 IPC handlers 是否已注册（registerIpcHandlersNow）。 */
	private _ipcRegistered = false;
	/** 窗口是否已完成加载（did-finish-load 已触发，渲染进程 onEvent 就绪）。 */
	private _rendererLoaded = false;

	constructor() {
		this.services = {
			mainWindow: null,
			runtimeManager: null,
			schedulerService: null,
			workspaceFileService: null,
			workspaceTreeService: null,
			larkChannelManager: null,
			larkBridgeService: null,
		};
	}

	private safeSendEvent(event: MainToRendererEvent): void {
		this.rendererEvents.send(event);
	}

	// ============================================================
	// Process boundary — safe console + uncaught error handlers
	// ============================================================

	private setupProcessBoundary(): void {
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

		process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
			if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
				return;
			}
			safeWrite("fatal", "Uncaught exception:", err.message, err.stack ?? "");
			try {
				if (
					this.services.mainWindow &&
					!this.services.mainWindow.isDestroyed() &&
					!this.services.mainWindow.webContents.isDestroyed()
				) {
					this.safeSendEvent({
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
				if (
					this.services.mainWindow &&
					!this.services.mainWindow.isDestroyed() &&
					!this.services.mainWindow.webContents.isDestroyed()
				) {
					this.safeSendEvent({
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
	// CSP
	// ============================================================

	private setupCsp(): void {
		if (!app.isPackaged) return;

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
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: file: https:",
			"font-src 'self' data:",
			`connect-src ${connectSrc}`,
			"media-src 'self' data: blob: file:",
			"frame-src 'self' data: blob:",
			"worker-src 'self' blob:",
			"object-src 'none'",
			"base-uri 'self'",
			"form-action 'none'",
		].join("; ");

		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			// Only inject CSP for document-level responses: main frames, sub-frames,
			// and XHR navigations. Skipping stylesheets, scripts, images, and
			// streaming API responses (LLM SSE) avoids per-response header overhead.
			if (
				details.resourceType !== "mainFrame" &&
				details.resourceType !== "subFrame" &&
				details.resourceType !== "xmlhttprequest"
			) {
				callback({ responseHeaders: details.responseHeaders });
				return;
			}
			callback({
				responseHeaders: {
					...details.responseHeaders,
					"Content-Security-Policy": [csp],
				},
			});
		});
	}

	// ============================================================
	// Window
	// ============================================================

	private createWindow(): void {
		const initialTone = readThemeToneSync(getUiSettingsPath());

		this.services.mainWindow = new BrowserWindow({
			width: 1400,
			height: 900,
			minWidth: 900,
			minHeight: 600,
			title: "Look",
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_INITIAL_Y },
			backgroundColor: initialTone === "light" ? "#fbfbfa" : "#030202",
			icon: path.join(__dirname, "assets/icon-1024.png"),
			webPreferences: {
				preload: path.join(__dirname, "preload.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		if (!app.isPackaged) {
			this.services.mainWindow.loadURL(`http://localhost:5174?theme=${initialTone}`);
			this.services.mainWindow.webContents.openDevTools();
		} else {
			this.services.mainWindow.loadFile(getPackagedRendererIndexPath(__dirname), {
				query: { theme: initialTone },
			});
		}

		this.services.mainWindow.on("closed", () => {
			this.services.mainWindow = null;
			closeViewerWindow();
			// 窗口关闭即重置就绪标志：macOS activate 重建窗口时，避免残留的
			// _rendererLoaded=true 导致 maybeSendAppReady 提前对未加载的新窗口
			// 发 app:ready（webContents.send 不排队，会静默丢失）。
			this._rendererLoaded = false;
			this._ipcRegistered = false;
		});

		this.services.mainWindow.webContents.on("did-finish-load", () => {
			replayUpdateStatus();
			void requestFreshCheck();
			// 渲染进程已完成加载（onEvent 已注册）→ 若 IPC 已注册则补发就绪信号。
			this._rendererLoaded = true;
			this.maybeSendAppReady();
			// 重放当前全屏状态：渲染进程加载前已进入全屏时 enter-full-screen
			// 事件已错过，不补发则红绿灯留白一直不收回。
			this.safeSendEvent({
				type: "window:fullscreen-changed",
				fullscreen: this.services.mainWindow?.isFullScreen() ?? false,
			});
		});

		this.services.mainWindow.on("enter-full-screen", () => {
			this.safeSendEvent({ type: "window:fullscreen-changed", fullscreen: true });
		});
		this.services.mainWindow.on("leave-full-screen", () => {
			this.safeSendEvent({ type: "window:fullscreen-changed", fullscreen: false });
		});

		this.services.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
			if (this.isAllowedExternalUrl(url)) {
				shell.openExternal(url).catch((error) => console.error("[Look] Failed to open external URL:", error));
			}
			return { action: "deny" };
		});
		this.services.mainWindow.webContents.on("will-navigate", (event, url) => {
			if (!this.isAllowedNavigationUrl(url)) {
				event.preventDefault();
				if (this.isAllowedExternalUrl(url)) {
					shell.openExternal(url).catch((error) => console.error("[Look] Failed to open external URL:", error));
				}
			}
		});
	}

	private isAllowedExternalUrl(raw: string): boolean {
		try {
			const url = new URL(raw);
			return url.protocol === "https:" || url.protocol === "http:";
		} catch {
			return false;
		}
	}

	private isAllowedNavigationUrl(raw: string): boolean {
		if (raw === "about:blank") return true;
		try {
			const url = new URL(raw);
			if (url.protocol === "file:") {
				// Only allow navigating back to the app's own renderer entry file.
				// Loading any other file: URL would keep the preload injected and
				// hand an attacker-controlled page the full IPC surface.
				if (app.isPackaged) {
					const entry = new URL(pathToFileURL(getPackagedRendererIndexPath(__dirname)).href);
					return url.pathname === entry.pathname;
				}
				return false;
			}
			if (!app.isPackaged && url.protocol === "http:" && url.hostname === "localhost" && url.port === "5174")
				return true;
			return false;
		} catch {
			return false;
		}
	}

	// ============================================================
	// Lark bridge
	// ============================================================

	private bootstrapLarkBridge(): void {
		if (!this.services.runtimeManager || !this.services.larkChannelManager || !this.services.larkBridgeService) {
			return;
		}
		try {
			if (this.services.larkBridgeService.init(this.services.runtimeManager, this.services.larkChannelManager)) {
				console.log("[Look] LarkBridgeService initialized");
			}
		} catch (err) {
			console.warn("[Look] Failed to initialize LarkBridgeService:", err);
		}
	}

	private detachLarkBridge(appId: string): void {
		this.services.larkBridgeService?.detachChannel(appId);
	}

	// ============================================================
	// Bootstrap — phased app initialization
	// ============================================================

	private async bootstrapApp(): Promise<void> {
		loadShellEnv();

		// Phase 1: Core runtime
		await this.bootstrapCoreRuntime();

		// Phase 2: Scheduler (depends on runtimeManager)
		this.services.schedulerService = this.createSchedulerService();
		this.services.runtimeManager!.setSchedulerService(this.services.schedulerService);

		// Phase 3: IM channels (depends on mainWindow + runtimeManager)
		// 提前到耗时初始化之前：registerIpcHandlers 依赖 lark 服务，
		// 必须尽早注册，避免渲染进程加载完成后 IPC 尚未就绪的启动竞态。
		this.bootstrapIM();

		// Phase 4: Register IPC early（渲染进程就绪信号在此之后发出）
		this.registerIpcHandlersNow();

		// Phase 5: Load persisted data
		await this.services.runtimeManager!.loadProjects();
		await this.services.runtimeManager!.recoverOrphanedProjects().catch((error) => {
			console.error("[Look] Orphaned project recovery failed:", error);
		});

		if (!this.services.mainWindow) return;

		// Phase 6: Restore workspace + push initial state
		await this.bootstrapStartupSequence();

		// Phase 7: Sync built-in skills and agents
		await this.syncBuiltinResources();
	}

	// ── Phase 1: Core runtime ──

	private async bootstrapCoreRuntime(): Promise<void> {
		this.services.workspaceFileService = new WorkspaceFileService();
		this.services.workspaceTreeService = new WorkspaceTreeService();
		this.services.runtimeManager = await SessionRuntimeManager.create(
			this.services.workspaceFileService,
			this.services.workspaceTreeService,
		);
	}

	// ── Phase 2: Scheduler ──

	private createSchedulerService(): SchedulerService {
		const schedulerOwnerId = `${process.pid}:${Date.now()}`;
		const callbacks = this.createSchedulerCallbacks();
		return new SchedulerService({
			store: new ScheduledTaskStore(getScheduledTasksPath()),
			lock: new FileTaskLock(getScheduledTaskLocksDir(), schedulerOwnerId),
			executor: new AgentScheduledTaskExecutor(new HeadlessAgentRunner(this.services.runtimeManager!)),
			ownerId: schedulerOwnerId,
			getProjectInfo: (projectId) => this.services.runtimeManager!.getProjectInfo(projectId),
			resolveNotificationTarget: this.createImNotificationResolver(),
			onAlert: callbacks.onAlert,
			onFinished: callbacks.onFinished,
		});
	}

	private createImNotificationResolver() {
		return async (
			notification: ScheduledTaskNotification,
		): Promise<{ chatId: string; channelAppId?: string } | null | undefined> => {
			if (!this.services.larkBridgeService) return undefined;
			if (notification.targetChatId && notification.channelAppId) {
				const binding = await this.services.larkBridgeService.resolveExplicitTarget(
					notification.channelAppId,
					notification.targetChatId,
				);
				return binding
					? { chatId: binding.chatId, channelAppId: binding.appId ?? notification.channelAppId }
					: null;
			}
			if (notification.targetChatId) {
				const appId = this.services.larkBridgeService
					.getBindings()
					.find((b) => b.chatId === notification.targetChatId)?.appId;
				return { chatId: notification.targetChatId, channelAppId: appId };
			}
			if (notification.channelAppId) {
				const binding = await this.services.larkBridgeService.resolveP2pBinding(notification.channelAppId);
				return binding ? { chatId: binding.chatId, channelAppId: notification.channelAppId } : null;
			}
			return null;
		};
	}

	private createSchedulerCallbacks() {
		const imResolver = this.createImNotificationResolver();

		return {
			onAlert: ({ task, log }: { task: { name: string }; log: { errorMessage?: string } }) => {
				const body = `${task.name}: ${log.errorMessage ?? "Task failed after all retry attempts"}`;
				this.safeSendEvent({ type: "error", message: body });
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
				if (!this.services.larkChannelManager) throw new Error("IM channel manager is not available");

				const succeeded = log.status === "success";
				const rawDetail = succeeded ? log.output || "" : log.errorMessage || "";
				const finishedAt = log.finishedAt ?? new Date().toISOString();

				const { text, card } = buildTaskFinishedNotification(
					task.name,
					succeeded,
					finishedAt,
					task.model,
					rawDetail,
				);

				const target = await imResolver(notification);
				if (target === undefined) throw new Error("IM bridge is not available");
				if (!target) {
					throw new Error("The selected bot has no private conversation with you yet; message it once in Feishu");
				}
				const result = await this.services.larkChannelManager.sendToChat(target.channelAppId, target.chatId, {
					text,
					card,
				});
				if (!result.success) throw new Error(result.error ?? "Failed to send IM notification");
			},
		};
	}

	// ── Phase 4: IM channels ──

	private bootstrapIM(): void {
		this.services.larkChannelManager = new LarkChannelManager(this.rendererEvents);
		this.services.larkBridgeService = new LarkBridgeService();
		this.services.larkChannelManager.onConnectionReady = () => this.bootstrapLarkBridge();
		this.services.larkChannelManager.onConnectionClosed = (appId) => this.detachLarkBridge(appId);
	}

	// ── Phase 4: IPC registration（提前到耗时初始化之前）──

	/**
	 * 两个条件都满足时发 app:ready：IPC 已注册 && 渲染进程已加载（onEvent 就绪）。
	 * 保证事件不会在渲染进程监听器注册前丢失（webContents.send 不排队）。
	 */
	private maybeSendAppReady(): void {
		if (this._ipcRegistered && this._rendererLoaded) {
			this.safeSendEvent({ type: "app:ready" as const });
		}
	}

	private registerIpcHandlersNow(): void {
		registerIpcHandlers(
			this.services.runtimeManager!.composition,
			this.services.mainWindow!,
			this.rendererEvents,
			this.services.larkChannelManager!,
			this.services.larkBridgeService!,
			this.services.schedulerService!,
		);

		// IPC 已就绪：若窗口已完成加载（渲染进程 onEvent 已注册），立即发就绪信号；
		// 否则由 did-finish-load 回调在加载完成时补发。两个标志保证不早发不丢发。
		this._ipcRegistered = true;
		this.maybeSendAppReady();
		console.log("[Look] IPC handlers registered");
	}

	// ── Phase 5: Workspace restore + service initialize ──

	private async bootstrapStartupSequence(): Promise<void> {
		this.bootstrapLarkBridge();

		const allProjects = this.services.runtimeManager!.listProjects();
		const activeProject = this.services.runtimeManager!.getActiveProject();
		this.safeSendEvent({
			type: "project:list" as const,
			projects: allProjects,
			activeProjectId: activeProject?.id ?? null,
		});

		await this.services.runtimeManager!.restoreWorkspace();

		const restoredProject = this.services.runtimeManager!.getActiveProject();
		if (restoredProject) {
			await promptForProjectTrust(this.services.runtimeManager!, restoredProject.id, this.services.mainWindow!);
		}

		await this.services.larkChannelManager!.initialize().catch((err) => {
			console.warn("[Look] Failed to initialize Feishu channel manager:", err);
		});
		this.bootstrapLarkBridge();
		await this.services.schedulerService!.initialize().catch((error) => {
			console.error("[Look] Failed to initialize scheduled tasks:", error);
		});
	}

	// ── Phase 6: Built-in resources ──

	private async syncBuiltinResources(): Promise<void> {
		const bundledResourceRoot = getBundledResourceRoot({
			isPackaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
			developmentRoot: path.resolve(__dirname, "../../.."),
		});

		try {
			const builtinPath = syncLookDefaultSkills(bundledResourceRoot);
			if (builtinPath) {
				await this.services.runtimeManager!.importSkillPaths([builtinPath]);
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

	// ============================================================
	// Dispose
	// ============================================================

	public async dispose(): Promise<void> {
		if (this.services.schedulerService) {
			try {
				await this.services.schedulerService.dispose();
			} catch (err) {
				console.error("[Look] schedulerService dispose failed:", err);
			}
			this.services.schedulerService = null;
		}
		if (this.services.larkBridgeService) {
			try {
				this.services.larkBridgeService.dispose();
			} catch (err) {
				console.error("[Look] larkBridgeService dispose failed:", err);
			}
			this.services.larkBridgeService = null;
		}
		if (this.services.larkChannelManager) {
			try {
				await this.services.larkChannelManager.dispose();
			} catch (err) {
				console.error("[Look] larkChannelManager dispose failed:", err);
			}
			this.services.larkChannelManager = null;
		}
		if (this.services.runtimeManager) {
			try {
				await this.services.runtimeManager.dispose();
			} catch (err) {
				console.error("[Look] runtimeManager dispose failed:", err);
			}
			this.services.runtimeManager = null;
		}
	}

	// ============================================================
	// Start — main entry
	// ============================================================

	public async start(): Promise<void> {
		await app.whenReady();

		this.setupProcessBoundary();
		this.setupCsp();
		registerOAuthProtocol();

		if (process.platform === "darwin" && app.dock) {
			const iconPath = path.join(__dirname, "assets/icon-1024.png");
			app.dock.setIcon(iconPath);
		}

		this.createWindow();
		initAppUpdater((e) => this.safeSendEvent(e));

		powerMonitor.on("resume", () => {
			void requestFreshCheck();
		});

		try {
			await this.bootstrapApp();
		} catch (err) {
			console.error("[Look] Fatal: Application bootstrap failed — quitting", err);
			app.quit();
			return;
		}

		app.on("activate", () => {
			if (this._disposing) return;
			if (BrowserWindow.getAllWindows().length === 0) {
				this.createWindow();
				if (this.services.mainWindow && this.services.runtimeManager) {
					registerIpcHandlers(
						this.services.runtimeManager.composition,
						this.services.mainWindow,
						this.rendererEvents,
						this.services.larkChannelManager ?? undefined,
						this.services.larkBridgeService ?? undefined,
						this.services.schedulerService ?? undefined,
					);
					this._ipcRegistered = true;
					this.maybeSendAppReady();
					this.services.larkChannelManager?.setMainWindow(this.services.mainWindow);
					const allProjects = this.services.runtimeManager.listProjects();
					const activeProject = this.services.runtimeManager.getActiveProject();
					this.safeSendEvent({
						type: "project:list" as const,
						projects: allProjects,
						activeProjectId: activeProject?.id ?? null,
					});
					for (const project of allProjects) {
						const agents = this.services.runtimeManager.listAgentsInProject(project.id);
						if (agents.length > 0) {
							this.safeSendEvent({
								type: "agent:list" as const,
								projectId: project.id,
								agents,
							});
						}
					}
				}
			}
		});

		app.on("window-all-closed", () => {
			if (process.platform !== "darwin") {
				app.quit();
			}
		});

		app.on("before-quit", (event) => {
			if (this._disposing) return;
			event.preventDefault();
			this._disposing = true;
			void this.dispose().finally(() => {
				app.quit();
			});
		});
	}
}
