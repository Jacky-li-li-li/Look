// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
//
// Exposes the Look IPC surface as `window.look` (canonical).
// No legacy `window.harness` alias remains; all renderer code
// must consume the API through `window.look`.
// ============================================================

const { contextBridge, ipcRenderer, webUtils } = require("electron");

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

  sendMessage: (agentId, message, images) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:send-message", agentId, message, images }),

  activateSession: (sessionId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:activate", agentId: sessionId }),

  createAgent: (input) =>
    ipcRenderer.invoke("look:invoke", {
      type: "agent:create",
      name: typeof input === "string" ? input : input?.name,
      projectId: typeof input === "object" ? input?.projectId : undefined,
    }),

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

  // ---- Custom providers ----
  addCustomProvider: (input) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:add-custom-provider", payload: input }),
  updateCustomProvider: (name, patch) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:update-custom-provider", payload: { name, patch } }),
  removeCustomProvider: (name) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:remove-custom-provider", payload: { name } }),
  listCustomProviders: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:list-custom-providers" }),
  testCustomProvider: (input) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:test-custom-provider", payload: input }),


  setApiKey: (provider, key) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:set-api-key", provider, key }),

  getGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:get" }),

  setGeneralSettings: (settings) =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:set", settings }),

  resetGeneralSettings: () =>
    ipcRenderer.invoke("look:invoke", { type: "settings:general:reset" }),

  compressSession: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "session:compress", agentId }),

  renameAgent: (agentId, name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:rename", agentId, name }),

  // ---- v0.3 skills ----
  listSkills: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:list" }),

  importSkillPaths: (paths) =>
    ipcRenderer.invoke("look:invoke", { type: "skills:import-paths", paths }),
  detectCommonSkillPaths: () =>
    ipcRenderer.invoke("look:invoke", { type: "skills:detect-common" }),

  // ---- OS native dialogs ----
  // Returns { success, path?, canceled?, error? }. The renderer
  // is sandboxed, so it can't call `dialog.showOpenDialog` itself.
  openDirectoryDialog: (title) =>
    ipcRenderer.invoke("look:invoke", { type: "dialog:open-directory", title }),
  openFileDialog: (options) =>
    ipcRenderer.invoke("look:invoke", {
      type: "dialog:open-files",
      title: options?.title,
      allowDirectories: options?.allowDirectories,
      allowMultiple: options?.allowMultiple,
    }),

  // ---- File paths from drag/drop ----
  // Electron's sandboxed renderer strips `file.path` from File objects.
  // Use webUtils.getPathForFile to recover the absolute path. Falls back
  // to null if webUtils is unavailable or the File object is invalid
  // (e.g. dragged directory — browsers don't expose directory paths).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  // ---- OS shell ----
  // Reveal a file in the OS file manager (Finder / Explorer / etc).
  revealInFinder: (path) =>
    ipcRenderer.invoke("look:invoke", { type: "shell:reveal-in-finder", path }),

  // Opens a project's canonical cwd in the OS file manager.
  openProjectFolder: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "shell:open-project-folder", projectId }),

  // ---- Project CRUD ----
  listProjects: () =>
    ipcRenderer.invoke("look:invoke", { type: "project:list" }),
  createProject: (cwd, name) =>
    ipcRenderer.invoke("look:invoke", { type: "project:create", cwd, name }),
  switchProject: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "project:switch", projectId }),
  renameProject: (projectId, name) =>
    ipcRenderer.invoke("look:invoke", { type: "project:rename", projectId, name }),
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
  // through the main process and the active AgentSessionRuntime.
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

  // ---- Shared area ----
  listSharedFiles: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:list", projectId }),
  startSharedWatch: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:watch", projectId }),
  stopSharedWatch: (projectId) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:unwatch", projectId }),
  writeSharedFile: (projectId, path, content) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:write", projectId, path, content }),
  createSharedDir: (projectId, path) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:mkdir", projectId, path }),
  deleteSharedItem: (projectId, path) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:delete", projectId, path }),
  importToShared: (projectId, sources, targetDir) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:import", projectId, sources, targetDir }),
  exportFromShared: (projectId, paths, destDir) =>
    ipcRenderer.invoke("look:invoke", { type: "shared:export", projectId, paths, destDir }),
  // Drag-drop fallback: write base64/utf8 content when no absolute path
  // is available (e.g. dropped into a sandboxed renderer).
  writeSharedContent: (projectId, path, content, encoding = "utf8") =>
    ipcRenderer.invoke("look:invoke", { type: "shared:write-content", projectId, path, content, encoding }),

  // ---- Workspace tree (v0.6) ----
  listWorkspaceChildren: (projectId, relativePath, showHiddenFiles = false) =>
    ipcRenderer.invoke("look:invoke", { type: "workspace:list-children", projectId, relativePath, showHiddenFiles }),
  statWorkspaceNode: (projectId, relativePath) =>
    ipcRenderer.invoke("look:invoke", { type: "workspace:stat", projectId, relativePath }),
  startWorkspaceWatch: (projectId, relativePath) =>
    ipcRenderer.invoke("look:invoke", { type: "workspace:watch", projectId, relativePath }),
  stopWorkspaceWatch: (projectId, relativePath) =>
    ipcRenderer.invoke("look:invoke", { type: "workspace:unwatch", projectId, relativePath }),

  // ---- Auto Updater ----
  checkForUpdates: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:check" }),
  downloadUpdate: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:download" }),
  installUpdate: () =>
    ipcRenderer.invoke("look:invoke", { type: "update:install" }),

  // ---- Permission management ----
  setPermissionMode: (agentId, mode) =>
    ipcRenderer.invoke("look:invoke", { type: "permission:set-mode", agentId, mode }),
  getPermissionMode: (agentId) =>
    ipcRenderer.invoke("look:invoke", { type: "permission:get-mode", agentId }),
  respondPermission: (payload) =>
    ipcRenderer.invoke("look:invoke", { type: "permission:respond", payload }),
  respondPlanQuestion: (payload) =>
    ipcRenderer.invoke("look:invoke", { type: "plan:question-respond", payload }),
  respondPlanApproval: (payload) =>
    ipcRenderer.invoke("look:invoke", { type: "plan:approval-respond", payload }),

  // ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
  listSubSessions: (parentSessionId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:list-subagents", parentSessionId }),
  getParentSession: (childSessionId) =>
    ipcRenderer.invoke("look:invoke", { type: "agent:get-parent-session", childSessionId }),

  // ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
  listAgentDefinitions: () =>
    ipcRenderer.invoke("look:invoke", { type: "agent-definitions:list" }),
  createAgentDefinition: (input) =>
    ipcRenderer.invoke("look:invoke", { type: "agent-definitions:create", input }),
  updateAgentDefinition: (name, input) =>
    ipcRenderer.invoke("look:invoke", { type: "agent-definitions:update", name, input }),
  deleteAgentDefinition: (name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent-definitions:delete", name }),
  installAgentDefinition: (name) =>
    ipcRenderer.invoke("look:invoke", { type: "agent-definitions:install", name }),

  // ---- User Profile ----
  getUserProfile: () =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:get" }),
  updateUserProfile: (patch) =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:update", patch }),
  resetUserProfile: () =>
    ipcRenderer.invoke("look:invoke", { type: "user-profile:reset" }),
};

contextBridge.exposeInMainWorld("look", api);
