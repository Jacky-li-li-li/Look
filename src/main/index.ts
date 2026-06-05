// ============================================================
// Electron Main Process Entry Point
// ============================================================

import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { AgentManager } from "./agent-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import type { AgentRole } from "./shared/types.js";

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
    const msg = `[${level}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
    try { process.stdout.write(msg); } catch { /* EPIPE — no terminal */ }
    try { process.stderr.write(msg); } catch { /* EPIPE — no terminal */ }
  };

  // Patch console to survive EPIPE (Electron has no real terminal)
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);
  console.log = (...args: any[]) => { try { _log(...args); } catch { safeWrite("info", ...args); } };
  console.warn = (...args: any[]) => { try { _warn(...args); } catch { safeWrite("warn", ...args); } };
  console.error = (...args: any[]) => { try { _error(...args); } catch { safeWrite("error", ...args); } };

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
  agentManager = new AgentManager(process.cwd());

  // Restore agents from ~/.look/ (async — must complete before checking listAgents)
  await agentManager.restoreWorkspace();

  // NOTE: We deliberately do NOT auto-load ANTHROPIC_API_KEY / OPENAI_API_KEY
  // (or any other env var) into runtime auth here. Doing so makes the Settings
  // UI and the model selector lie — they would show providers the user never
  // configured as "configured". Users set keys via the Settings UI, which
  // persists to ~/.pi/agent/auth.json. Env vars are still discoverable as a
  // fallback by pi's getApiKey() (priority 4), so they remain usable at call
  // time, just not advertised in the UI.

  // Only create default Orchestrator if no agents were restored from disk
  const existingAgents = agentManager.listAgents();
  if (existingAgents.length === 0) {
    console.log("[Look] Creating default Orchestrator...");
    try {
      const orchId = await agentManager.createAgent({
        name: "Orchestrator",
        role: "orchestrator" as AgentRole,
      });
      console.log(`[Look] ✅ Orchestrator created: ${orchId}`);
    } catch (err: any) {
      console.error("[Look] ❌ Failed to create Orchestrator:", err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("look:event", {
          type: "error",
          message: `Failed to create Orchestrator: ${err.message}. Check API key and network.`,
        });
      }
    }
  } else {
    console.log(`[Look] Restored ${existingAgents.length} agent(s), skipping default creation`);
  }

  if (mainWindow) {
    registerIpcHandlers(agentManager, mainWindow);
    console.log("[Look] IPC handlers registered");
  }
}

// ============================================================
// App Lifecycle
// ============================================================

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

app.on("window-all-closed", async () => {
  if (agentManager) {
    const agents = agentManager.listAgents();
    for (const agent of agents) {
      await agentManager.destroyAgent(agent.id);
    }
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
