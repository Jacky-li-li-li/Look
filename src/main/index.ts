// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { app, BrowserWindow, session } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { AgentManager } from "./agent-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { loadShellEnv } from "./shell-env-loader.js";
import { checkForUpdates, initUpdater } from "./updater.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;

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
	const safeWrite = (level: string, ...args: any[]) => {
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
	console.log = (...args: any[]) => {
		try {
			_log(...args);
		} catch {
			safeWrite("info", ...args);
		}
	};
	console.warn = (...args: any[]) => {
		try {
			_warn(...args);
		} catch {
			safeWrite("warn", ...args);
		}
	};
	console.error = (...args: any[]) => {
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
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", {
				type: "error",
				message: `Process error: ${err.message}`,
			});
		}
	});

	process.on("unhandledRejection", (reason: any) => {
		safeWrite("fatal", "Unhandled rejection:", reason?.message ?? reason);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", {
				type: "error",
				message: `Unhandled rejection: ${reason?.message ?? String(reason)}`,
			});
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
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "Look",
		icon: path.join(__dirname, "assets/icon-1024.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL("http://localhost:5174");
		mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

// ============================================================
// Agent Initialization
// Uses pi's retry settings for Layer 1 protection
// ============================================================

async function initAgentManager(): Promise<void> {
	loadShellEnv();

	agentManager = new AgentManager();

	// Load projects first, then restore agents
	await agentManager.loadProjects();
	await agentManager.restoreWorkspace();

	// Restore last active project from UI settings
	let lastActiveProjectId: string | null = null;
	try {
		const { getUiSettingsPath } = await import("./shared/look-storage.js");
		const fs = await import("node:fs");
		const uiPath = getUiSettingsPath();
		if (fs.existsSync(uiPath)) {
			const uiSettings = JSON.parse(fs.readFileSync(uiPath, "utf-8"));
			lastActiveProjectId = uiSettings.lastActiveProjectId ?? null;
		}
	} catch {
		// Ignore errors reading UI settings
	}

	// Set active project
	const projects = agentManager.listProjects();
	if (lastActiveProjectId && projects.some((p: any) => p.id === lastActiveProjectId)) {
		agentManager.setActiveProject(lastActiveProjectId);
		console.log(`[Look] Restored active project: ${lastActiveProjectId}`);
	} else if (projects.length > 0) {
		const firstValid = projects.find((p: any) => p.valid);
		if (firstValid) {
			agentManager.setActiveProject(firstValid.id);
			console.log(`[Look] Activated first valid project: ${firstValid.id}`);
		}
	}

	// The app requires the user to select a project folder first
	// before any agent can be created. No auto-creation of default agents.

	if (mainWindow) {
		registerIpcHandlers(agentManager, mainWindow);

		// Push initial state: projects + agents + history
		const allProjects = agentManager.listProjects();
		const activeProject = agentManager.getActiveProject();
		mainWindow.webContents.send("look:event", {
			type: "project:list" as const,
			projects: allProjects,
			activeProjectId: activeProject?.id ?? null,
		});

		if (activeProject) {
			const snapshot = agentManager.listAgentsWithHistory();
			if (snapshot.agents.length > 0) {
				mainWindow.webContents.send("look:event", {
					type: "agent:list" as const,
					agentId: "",
					agents: snapshot.agents,
				});
				for (const [agentId, msgs] of Object.entries(snapshot.history)) {
					if (msgs.length > 0) {
						mainWindow.webContents.send("look:event", {
							type: "agent:history" as const,
							agentId,
							messages: msgs,
						});
					}
				}
			}
		}

		console.log("[Look] IPC handlers registered");

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
	await initAgentManager();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
			if (mainWindow && agentManager) {
				registerIpcHandlers(agentManager, mainWindow);
				const allProjects = agentManager.listProjects();
				const activeProject = agentManager.getActiveProject();
				mainWindow.webContents.send("look:event", {
					type: "project:list" as const,
					projects: allProjects,
					activeProjectId: activeProject?.id ?? null,
				});
				if (activeProject) {
					const snapshot = agentManager.listAgentsWithHistory();
					if (snapshot.agents.length > 0) {
						mainWindow.webContents.send("look:event", {
							type: "agent:list" as const,
							agentId: "",
							agents: snapshot.agents,
						});
					}
				}
			}
		}
	});
});

app.on("window-all-closed", () => {
	// pi SDK auto-saves session state on every turn. We do NOT
	// destroy agents here — listAgents() now filters by active
	// project and would miss agents in other projects.
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Clean up MCP server subprocesses on quit so we don't leave
// orphaned child processes behind.
app.on("before-quit", async () => {
	if (agentManager) {
		try {
			await agentManager.getMcpManager().disconnectAll();
		} catch {
			// best-effort cleanup
		}
	}
});
