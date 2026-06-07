// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { AgentManager } from "./agent-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;

const isDev = !app.isPackaged;

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

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "Look",
		icon: path.join(__dirname, "assets/icon-512.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		mainWindow.loadURL("http://localhost:5173");
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
	}
}

app.whenReady().then(async () => {
	setupProcessBoundary();

	// Set Dock icon on macOS (PNG supported since Electron 20+)
	if (process.platform === "darwin" && app.dock) {
		const iconPath = path.join(__dirname, "assets/icon-512.png");
		app.dock.setIcon(iconPath);
	}

	createWindow();
	await initAgentManager();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
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
