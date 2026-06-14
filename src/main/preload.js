// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
//
// Exposes the Look IPC surface as `window.look` (canonical). The
// legacy `window.harness` name is also exposed as a non-breaking
// alias so older code paths keep working until they migrate.
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  // User home directory, exposed as a sync constant so the renderer can
  // shorten absolute paths to ~/… (matches pi sdk's path display). In a
  // sandboxed preload we can't require("os"), but process.env is available.
  homedir: process.env.HOME || process.env.USERPROFILE || "",

  send: (event) => ipcRenderer.send("look:event", event),
  invoke: (event) => ipcRenderer.invoke("look:invoke", event),

  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("look:event", handler);
    return () => { ipcRenderer.removeListener("look:event", handler); };
  },

  sendMessage: (agentId, message) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:send-message", agentId, message }),

  createAgent: (name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:create", name }),

  destroyAgent: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:destroy", agentId }),

  abortAgent: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:abort", agentId }),

  getModels: () =>
    ipcRenderer.invoke("look:invoke", { type: "model:list" }),

  getProviders: () =>
    ipcRenderer.invoke("look:invoke", { type: "model:providers" }),

  getAgents: () =>
    ipcRenderer.invoke("look:invoke", { type: "agents:list" }),

  switchModel: (agentId, model) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:switch-model", agentId, model }),

  updateThinking: (agentId, level) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:update-thinking", agentId, level }),

  getHistory: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:get-history", agentId }),

  getSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:get" }),

  getApiKey: (provider) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:get-api-key", provider }),

  testApiKey: (provider, key) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:test-api-key", provider, key }),

  // Test the env-var credential for a provider (no key arg — the
  // main process reads it from process.env itself, so the renderer
  // never has to know the variable name).
  testEnvKey: (provider) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:test-env-key", provider }),


  setApiKey: (provider, key) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:set-api-key", provider, key }),

  getGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:get" }),

  setGeneralSettings: (settings) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:set", settings }),

  resetGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:reset" }),

  getContextUsage: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "context:usage", agentId }),

  compressSession: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "session:compress", agentId }),

  renameAgent: (agentId, name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:rename", agentId, name }),

  respondPermission: (decision) =>
    // decision: { action: "allow" | "deny" | "edit", reason?, args? }
    ipcRenderer.invoke("look:invoke", { type: "permission:response", ...decision }),

  setPermissionMode: (agentId, mode) =>
    ipcRenderer.invoke("look:invoke", { type: "permission:set-mode", agentId, mode }),

  // ---- v0.3 skills ----
  listSkills: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:list" }),
  invokeSkill: (agentId, skillName, args) =>
    ipcRenderer.invoke("look:invoke", { type: "skills:invoke", agentId, skillName, args }),
  importSkillPaths: (paths) =>
    ipcRenderer.invoke("look:invoke", { type: "skills:import-paths", paths }),
  detectCommonSkillPaths: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:detect-common" }),

  // ---- OS native dialogs ----
  // Returns { success, path?, canceled?, error? }. The renderer
  // is sandboxed, so it can't call `dialog.showOpenDialog` itself.
  openDirectoryDialog: () =>
    ipcRenderer.invoke("look:invoke", { type: "dialog:open-directory" }),

  // ---- OS shell ----
  // Reveal a file in the OS file manager (Finder / Explorer / etc).
  revealInFinder: (path) =>
    ipcRenderer.invoke("look:invoke", { type: "shell:reveal-in-finder", path }),

  // Opens the sessions directory (~/.look/sessions/) in the OS file manager.
  // Contains all session .jsonl files for each agent.
  openProjectFolder: () =>
    ipcRenderer.invoke("look:invoke", { type: "shell:open-project-folder" }),

  // ---- Project CRUD ----
  listProjects: () =>
    ipcRenderer.invoke("look:invoke", { type: "project:list" }),
  createProject: (cwd, name) =>
    ipcRenderer.invoke("look:invoke", { type: "project:create", cwd, name }),
  switchProject: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "project:switch", projectId }),
  deleteProject: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "project:delete", projectId }),
  confirmDeleteProject: (projectId, confirmed) =>
    ipcRenderer.invoke("look:invoke", { type: "project:confirm-delete-response", projectId, confirmed }),
  getActiveProject: () =>
    ipcRenderer.invoke("look:invoke", { type: "project:get-active" }),

  // ---- v0.4 Session tree / branching ----
  // `window.look.*` API surface for the tree-view UI and the
  // hover-action buttons in MessageBubble. The renderer never
  // touches pi's SessionManager directly — all reads/writes go
  // through the main process so the in-memory mirror on
  // `ManagedAgent` stays the single source of truth.
  getSessionTree: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:get-session-tree", agentId }),
  getForkPoints: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:get-fork-points", agentId }),
  // opts: { summarize?, customInstructions?, label? }
  // returns: { editorText?, cancelled: boolean, aborted?: boolean }
  navigateTree: (agentId, entryId, opts) =>
    ipcRenderer.invoke("look:invoke", {
      type: "agent:navigate-tree",
      agentId,
      entryId,
      summarize: opts?.summarize,
      customInstructions: opts?.customInstructions,
      label: opts?.label,
    }),
  // opts: { name? } — defaults to `${parentName} · fork`
  // returns: { agentId, sessionFilePath }
  createFork: (agentId, entryId, opts) =>
    ipcRenderer.invoke("look:invoke", {
      type: "agent:create-fork",
      agentId,
      entryId,
      name: opts?.name,
    }),
  // label: string | null — null/empty clears
  setEntryLabel: (agentId, entryId, label) =>
    ipcRenderer.invoke("look:invoke", {
      type: "agent:set-entry-label",
      agentId,
      entryId,
      label,
    }),

  // ---- Auto Updater ----
  checkForUpdates: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:check" }),
  downloadUpdate: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:download" }),
  installUpdate: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:install" }),

  // ---- User Profile ----
  getUserProfile: () =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:get" }),
  updateUserProfile: (patch) =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:update", patch }),
  resetUserProfile: () =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:reset" }),
};

contextBridge.exposeInMainWorld("look", api);
